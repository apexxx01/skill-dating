import type { Prisma, PrismaClient } from '@prisma/client'
import type { AchievementItem } from '@/types/api'
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_SLUGS, type AchievementCriteria, type AchievementDefinition, type AchievementSlug } from '@/lib/achievement-definitions'
import { readCounters } from '@/lib/metrics'
import { readUserStreak } from '@/lib/streak-status'

type Db = PrismaClient | Prisma.TransactionClient

// What GET /api/achievements and GET /api/users/{id}/achievements show: the whole catalog, each
// with whether this user has it, how far along they are and how rare it is. The text comes from the
// database row when there is one (an operator may have edited it) and from the definitions otherwise;
// the numbers come from the user's counters and streak.

export const SECRET_NAME = 'Secret achievement'
export const SECRET_DESCRIPTION = 'Keep building to find out what unlocks it.'

/** The key a hidden achievement is listed under: stable, and not its slug, which would give the rule away. */
export const secretPlaceholderSlug = (order: number) => `secret-${order}`

export function progressOf(criteria: AchievementCriteria, counters: Record<string, number>, streak: number): { current: number; target: number } {
  if (!('metric' in criteria)) return { current: 0, target: criteria.target }
  const value = criteria.metric === 'streak_days' ? streak : counters[criteria.metric] ?? 0
  return { current: Math.min(value, criteria.target), target: criteria.target }
}

export async function loadAchievementItems(db: Db, userId: string): Promise<AchievementItem[]> {
  const [rows, earnedRows, counters, streak] = await Promise.all([
    db.achievement.findMany({
      where: { slug: { in: ACHIEVEMENT_SLUGS } },
      select: { slug: true, name: true, description: true, icon: true, xpReward: true, rarity: true },
    }),
    db.userAchievement.findMany({ where: { userId }, select: { earnedAt: true, progress: true, achievement: { select: { slug: true } } } }),
    readCounters(db, userId),
    readUserStreak(db, userId),
  ])
  const row = new Map(rows.map((entry) => [entry.slug, entry]))
  const earned = new Map(earnedRows.map((entry) => [entry.achievement.slug, entry]))
  const streakNow = streak?.current ?? 0

  return [...ACHIEVEMENT_SLUGS]
    .sort((a, b) => ACHIEVEMENT_DEFINITIONS[a].order - ACHIEVEMENT_DEFINITIONS[b].order)
    .map((slug): AchievementItem => {
      const def: AchievementDefinition = ACHIEVEMENT_DEFINITIONS[slug as AchievementSlug]
      const stored = row.get(slug)
      const mine = earned.get(slug)
      const secret = Boolean(def.isSecret)

      // A secret achievement stays hidden until it is earned: its name, text, icon, reward, target and rarity are withheld.
      if (secret && !mine) {
        return {
          slug: secretPlaceholderSlug(def.order),
          name: SECRET_NAME,
          description: SECRET_DESCRIPTION,
          icon: null,
          category: def.category,
          xpReward: null,
          secret: true,
          masked: true,
          earned: false,
          earnedAt: null,
          progress: null,
          rarity: null,
          order: def.order,
        }
      }

      const live = progressOf(def.criteria, counters, streakNow)
      const stamp = mine?.progress as { current?: number; target?: number } | null | undefined
      return {
        slug,
        name: stored?.name ?? def.name,
        description: stored?.description ?? def.description,
        icon: stored?.icon ?? def.icon,
        category: def.category,
        xpReward: stored?.xpReward ?? def.xpReward,
        secret,
        masked: false,
        earned: Boolean(mine),
        earnedAt: mine ? mine.earnedAt.toISOString() : null,
        // Once earned the bar is full, whatever the counter has done since (a streak can fall).
        progress: mine ? { current: Math.max(stamp?.target ?? live.target, live.target), target: live.target } : live,
        rarity: stored?.rarity ?? null,
        order: def.order,
      }
    })
}
