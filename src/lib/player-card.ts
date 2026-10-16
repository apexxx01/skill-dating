import type { PrismaClient } from '@prisma/client'
import type { PlayerCard } from '@/types/api'
import { COSMETIC_BY_SLUG } from '@/lib/cosmetic-definitions'
import { readEquipped } from '@/lib/cosmetics'
import { getCache, type Cache } from '@/lib/infra/cache'
import { boardKey, scopesOf } from '@/lib/leaderboard-boards'
import { ensureBoardsBuilt } from '@/lib/leaderboard-read'
import { currentPeriods, loadMembership } from '@/lib/leaderboard-write'
import { levelFor } from '@/lib/levels'
import { log } from '@/lib/log'
import { readCounters } from '@/lib/metrics'
import { effectiveStreak, streakDay, streakFromColumns } from '@/lib/streaks'
import { STATS_TTL_MS, statsCacheKey } from '@/lib/xp-views'

// The player card: everything a profile header shows about someone's progress, in one call. It is the same
// for every viewer (rank here is the place on the all-time board, the same number the leaderboard shows for
// that person to every viewer), so it is cached for 60 seconds as a whole and thrown
// away whenever the person earns anything. What a particular viewer may see of it (the streak, when the
// person keeps their activity private) is decided after the cache, in forViewer().

type Db = Pick<PrismaClient, 'user' | 'profile' | 'season' | 'userAchievement' | 'userCounter' | 'teamMember' | '$queryRaw'>

const TOP_ACHIEVEMENTS = 3

export async function buildPlayerCard(db: Db, cache: Cache, userId: string, now: Date = new Date()): Promise<PlayerCard | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, xp: true, timezone: true, deletedAt: true, equipped: true, currentStreak: true, longestStreak: true, lastStreakDay: true, streakFreezes: true, streakFreezeUsed: true },
  })
  if (!user || user.deletedAt) return null

  const [membership, periods, counters, earned, crews] = await Promise.all([
    loadMembership(db, userId),
    currentPeriods(db, now),
    readCounters(db, userId),
    db.userAchievement.findMany({
      where: { userId },
      select: { earnedAt: true, achievement: { select: { slug: true, name: true, icon: true, rarity: true, xpReward: true } } },
    }),
    db.teamMember.count({ where: { userId } }),
  ])

  // Absolute place on the all-time boards the person is on. Nobody on none of them (opted out) has no rank. If the
  // cache is unreachable the card still comes back, without ranks, rather than not at all.
  const scopes = scopesOf(membership)
  const ranks: { global: number | null; country: number | null; city: number | null } = { global: null, country: null, city: null }
  try {
    await ensureBoardsBuilt(db, cache)
    const allTime = periods.find((period) => period.period === 'all-time')!
    await Promise.all(
      (['global', 'country', 'city'] as const).map(async (kind) => {
        const scope = scopes.find((candidate) => candidate.scope === kind)
        if (!scope) return
        const position = await cache.zrevrank(boardKey(allTime, scope), userId)
        ranks[kind] = position === null ? null : position + 1
      })
    )
  } catch (error) {
    log.warn('could not read ranks for a player card', { error, userId })
  }

  const level = levelFor(user.xp)
  const equipped = readEquipped(user.equipped)
  const worn = (slug: string | null) => (slug ? { slug, name: COSMETIC_BY_SLUG.get(slug)!.name } : null)
  const state = streakFromColumns(user)
  // The rarest first: a smaller share of people has it. An unknown rarity (the nightly job has not run) sorts last, then by reward.
  const top = [...earned]
    .sort((a, b) => (a.achievement.rarity ?? 2) - (b.achievement.rarity ?? 2) || b.achievement.xpReward - a.achievement.xpReward || a.earnedAt.getTime() - b.earnedAt.getTime())
    .slice(0, TOP_ACHIEVEMENTS)
    .map((row) => ({ slug: row.achievement.slug, name: row.achievement.name, icon: row.achievement.icon, rarity: row.achievement.rarity, earnedAt: row.earnedAt.toISOString() }))

  return {
    userId,
    xp: user.xp,
    level: level.level,
    tier: level.tier,
    progress: { xpIntoLevel: level.xpIntoLevel, xpForNextLevel: level.xpForNextLevel, fraction: level.progress },
    ranks,
    equipped: {
      title: worn(equipped.title),
      frame: worn(equipped.frame),
      banner: worn(equipped.banner),
    },
    streak: { current: effectiveStreak(state, streakDay(now, user.timezone)), longest: state.longest, freezes: state.freezes, lastDay: state.lastDay },
    topAchievements: top,
    counts: {
      shipped: counters.ships ?? 0,
      hackathons: counters.hackathons_joined ?? 0,
      wins: counters.hackathon_wins ?? 0,
      endorsementsReceived: counters.endorsements_received ?? 0,
      crews,
      milestones: counters.milestones ?? 0,
    },
  }
}

/** The card for a user, from the cache when it is under a minute old. Null for a user that does not exist or is gone. */
export async function loadPlayerCard(db: Db, userId: string, cache: Cache = getCache(), now: Date = new Date()): Promise<PlayerCard | null> {
  const key = statsCacheKey(userId)
  try {
    const cached = await cache.get(key)
    if (cached) return JSON.parse(cached) as PlayerCard
  } catch {
    // A cache that is down or holds something unreadable is no reason to fail: build it.
  }
  const card = await buildPlayerCard(db, cache, userId, now)
  if (card) {
    try {
      await cache.set(key, JSON.stringify(card), { ttlMs: STATS_TTL_MS })
    } catch {
      // Not cached; the next read builds it again.
    }
  }
  return card
}

/** What this viewer may see of a card. Somebody who keeps their activity private shows no streak to others. */
export function forViewer(card: PlayerCard, viewer: { isOwner: boolean; showActivity: boolean }): PlayerCard {
  if (viewer.isOwner || viewer.showActivity) return card
  return { ...card, streak: null }
}
