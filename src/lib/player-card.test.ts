import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryCache } from './infra/cache.memory'
import { boardKey, periodsAt } from './leaderboard-boards'
import { BOARDS_READY_KEY } from './leaderboard-write'
import { buildPlayerCard, forViewer, loadPlayerCard } from './player-card'
import { statsCacheKey } from './xp-views'
import { xpAtLevelStart } from './levels'
import type { PlayerCard } from '@/types/api'

const now = new Date('2026-10-16T12:00:00Z')
const [, , , allTime] = periodsAt(now, { id: 'season-1', endsAt: new Date('2026-12-11T00:00:00Z') })

interface Setup {
  user?: Partial<{ equipped: unknown; xp: number; timezone: string | null; deletedAt: Date | null; currentStreak: number; longestStreak: number; lastStreakDay: string | null; streakFreezes: number }> | null
  profile?: { hideFromLeaderboards?: boolean; countryCode?: string | null; cityKey?: string | null; campusKey?: string | null } | null
  counters?: Record<string, number>
  earned?: { slug: string; name: string; icon?: string | null; rarity: number | null; xpReward: number; earnedAt: string }[]
  crews?: number
}

function fakeDb(setup: Setup = {}) {
  return {
    user: {
      findUnique: vi.fn(async () =>
        setup.user === null
          ? null
          : { id: 'u1', xp: 0, timezone: null, deletedAt: null, currentStreak: 0, longestStreak: 0, lastStreakDay: null, streakFreezes: 0, streakFreezeUsed: false, ...(setup.user ?? {}) }
      ),
    },
    profile: {
      findUnique: vi.fn(async () =>
        setup.profile ? { hideFromLeaderboards: setup.profile.hideFromLeaderboards ?? false, countryCode: setup.profile.countryCode ?? null, cityKey: setup.profile.cityKey ?? null, campusKey: setup.profile.campusKey ?? null } : null
      ),
    },
    season: { findFirst: vi.fn(async () => ({ id: 'season-1', endsAt: new Date('2026-12-11T00:00:00Z') })) },
    userAchievement: {
      findMany: vi.fn(async () =>
        (setup.earned ?? []).map((row) => ({ earnedAt: new Date(row.earnedAt), achievement: { slug: row.slug, name: row.name, icon: row.icon ?? null, rarity: row.rarity, xpReward: row.xpReward } }))
      ),
    },
    userCounter: { findMany: vi.fn(async () => Object.entries(setup.counters ?? {}).map(([key, value]) => ({ key, value }))) },
    teamMember: { count: vi.fn(async () => setup.crews ?? 0) },
    $queryRaw: vi.fn(async () => []),
  } as never
}

let cache: MemoryCache
beforeEach(async () => {
  cache = new MemoryCache()
  await cache.set(BOARDS_READY_KEY, 'x')
})

describe('buildPlayerCard', () => {
  it('is null for a user that does not exist or is gone', async () => {
    expect(await buildPlayerCard(fakeDb({ user: null }), cache, 'u1', now)).toBeNull()
    expect(await buildPlayerCard(fakeDb({ user: { deletedAt: new Date() } }), cache, 'u1', now)).toBeNull()
  })

  it('reports XP, level, tier and progress through the level', async () => {
    const card = (await buildPlayerCard(fakeDb({ user: { xp: xpAtLevelStart(20) + 100 } }), cache, 'u1', now))!
    expect(card).toMatchObject({ userId: 'u1', xp: xpAtLevelStart(20) + 100, level: 20, tier: 'GOLD' })
    expect(card.progress).toMatchObject({ xpIntoLevel: 100, xpForNextLevel: 1276 })
    expect(card.progress.fraction).toBeCloseTo(100 / 1276, 6)
  })

  it('shows the absolute place on the all-time global, country and city boards', async () => {
    for (const [scope, entries] of Object.entries({ g: ['a', 'b', 'u1', 'c'], 'c:IN': ['a', 'u1'], 'y:IN:pune': ['u1'] })) {
      for (const [index, member] of entries.entries()) await cache.zadd(boardKey(allTime, scope), member, 100 - index)
    }
    const card = (await buildPlayerCard(fakeDb({ profile: { countryCode: 'IN', cityKey: 'pune' } }), cache, 'u1', now))!
    expect(card.ranks).toEqual({ global: 3, country: 2, city: 1 })
  })

  it('has no rank where the person is not on the board: no place set, no XP, or opted out', async () => {
    await cache.zadd(boardKey(allTime, 'g'), 'u1', 5)
    expect((await buildPlayerCard(fakeDb(), cache, 'u1', now))!.ranks).toEqual({ global: 1, country: null, city: null })
    expect((await buildPlayerCard(fakeDb(), cache, 'nobody', now))!.ranks.global).toBeNull()
    expect((await buildPlayerCard(fakeDb({ profile: { hideFromLeaderboards: true, countryCode: 'IN' } }), cache, 'u1', now))!.ranks).toEqual({ global: null, country: null, city: null })
  })

  it('names what the person wears, a season title and up to three badges included', async () => {
    const equipped = { title: 'season-2-top-100', frame: 'frame-streak-7', banner: null, badges: ['season-1-participant', 'season-2-participant', 'season-3-participant', 'season-4-participant'] }
    const card = (await buildPlayerCard(fakeDb({ user: { equipped } }), cache, 'u1', now))!
    expect(card.equipped).toEqual({
      title: { slug: 'season-2-top-100', name: 'Season 2 Top 100' },
      frame: { slug: 'frame-streak-7', name: 'Ember' },
      banner: null,
      badges: [
        { slug: 'season-1-participant', name: 'Season 1 Participant' },
        { slug: 'season-2-participant', name: 'Season 2 Participant' },
        { slug: 'season-3-participant', name: 'Season 3 Participant' },
      ],
    })
    expect((await buildPlayerCard(fakeDb(), cache, 'u1', now))!.equipped).toEqual({ title: null, frame: null, banner: null, badges: [] })
  })

  it('reports the live streak: 0 once it has lapsed, with the best run kept', async () => {
    const live = (await buildPlayerCard(fakeDb({ user: { currentStreak: 12, longestStreak: 30, lastStreakDay: '2026-10-15', streakFreezes: 1 } }), cache, 'u1', now))!
    expect(live.streak).toEqual({ current: 12, longest: 30, freezes: 1, lastDay: '2026-10-15' })
    const lapsed = (await buildPlayerCard(fakeDb({ user: { currentStreak: 12, longestStreak: 30, lastStreakDay: '2026-10-01' } }), cache, 'u1', now))!
    expect(lapsed.streak).toMatchObject({ current: 0, longest: 30 })
  })

  it('names the three rarest earned achievements, rarest first, and puts an unknown rarity last', async () => {
    const earned = [
      { slug: 'common', name: 'Common', rarity: 0.6, xpReward: 25, earnedAt: '2026-01-01T00:00:00Z' },
      { slug: 'rare', name: 'Rare', rarity: 0.02, xpReward: 400, earnedAt: '2026-02-01T00:00:00Z' },
      { slug: 'unknown', name: 'Unknown', rarity: null, xpReward: 999, earnedAt: '2026-03-01T00:00:00Z' },
      { slug: 'rarer', name: 'Rarer', rarity: 0.005, xpReward: 1000, earnedAt: '2026-04-01T00:00:00Z' },
      { slug: 'uncommon', name: 'Uncommon', rarity: 0.2, xpReward: 100, earnedAt: '2026-05-01T00:00:00Z' },
    ]
    const card = (await buildPlayerCard(fakeDb({ earned }), cache, 'u1', now))!
    expect(card.topAchievements.map((item) => item.slug)).toEqual(['rarer', 'rare', 'uncommon'])
    expect(card.topAchievements[0]).toEqual({ slug: 'rarer', name: 'Rarer', icon: null, rarity: 0.005, earnedAt: '2026-04-01T00:00:00.000Z' })
    const unknownOnly = (await buildPlayerCard(fakeDb({ earned: [earned[0], earned[2]] }), cache, 'u1', now))!
    expect(unknownOnly.topAchievements.map((item) => item.slug)).toEqual(['common', 'unknown'])
  })

  it('breaks a tie in rarity by the bigger reward, then the earlier unlock', async () => {
    const earned = [
      { slug: 'b', name: 'B', rarity: 0.1, xpReward: 100, earnedAt: '2026-02-01T00:00:00Z' },
      { slug: 'a', name: 'A', rarity: 0.1, xpReward: 200, earnedAt: '2026-03-01T00:00:00Z' },
      { slug: 'c', name: 'C', rarity: 0.1, xpReward: 100, earnedAt: '2026-01-01T00:00:00Z' },
    ]
    expect((await buildPlayerCard(fakeDb({ earned }), cache, 'u1', now))!.topAchievements.map((item) => item.slug)).toEqual(['a', 'c', 'b'])
  })

  it('has no top achievements for somebody who has earned none', async () => {
    expect((await buildPlayerCard(fakeDb(), cache, 'u1', now))!.topAchievements).toEqual([])
  })

  it('counts what was shipped, joined, won, endorsed, completed and the teams the person is in', async () => {
    const counters = { ships: 4, hackathons_joined: 6, hackathon_wins: 1, endorsements_received: 9, milestones: 31, updates: 100 }
    const card = (await buildPlayerCard(fakeDb({ counters, crews: 2 }), cache, 'u1', now))!
    expect(card.counts).toEqual({ shipped: 4, hackathons: 6, wins: 1, endorsementsReceived: 9, crews: 2, milestones: 31 })
    expect((await buildPlayerCard(fakeDb(), cache, 'u1', now))!.counts).toEqual({ shipped: 0, hackathons: 0, wins: 0, endorsementsReceived: 0, crews: 0, milestones: 0 })
  })
})

describe('loadPlayerCard: the cache', () => {
  it('builds the card once and serves the next reads from the cache', async () => {
    const db = fakeDb({ counters: { ships: 1 } })
    const first = await loadPlayerCard(db, 'u1', cache, now)
    const second = await loadPlayerCard(db, 'u1', cache, now)
    expect(second).toEqual(first)
    expect((db as unknown as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique).toHaveBeenCalledTimes(1)
  })

  it('keeps it for 60 seconds, and builds a new one after that', async () => {
    const clock = { now: 1_000_000 }
    const timed = new MemoryCache(1000, () => clock.now)
    await timed.set(BOARDS_READY_KEY, 'x')
    const db = fakeDb()
    await loadPlayerCard(db, 'u1', timed, now)
    clock.now += 59_000
    await loadPlayerCard(db, 'u1', timed, now)
    expect((db as unknown as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique).toHaveBeenCalledTimes(1)
    clock.now += 2_000
    await loadPlayerCard(db, 'u1', timed, now)
    expect((db as unknown as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique).toHaveBeenCalledTimes(2)
  })

  it('builds a new one as soon as the cached card is thrown away, which is what an award does', async () => {
    const db = fakeDb()
    await loadPlayerCard(db, 'u1', cache, now)
    await cache.del(statsCacheKey('u1'))
    await loadPlayerCard(db, 'u1', cache, now)
    expect((db as unknown as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique).toHaveBeenCalledTimes(2)
  })

  it('does not cache a missing user', async () => {
    const db = fakeDb({ user: null })
    expect(await loadPlayerCard(db, 'u1', cache, now)).toBeNull()
    expect(await cache.get(statsCacheKey('u1'))).toBeNull()
  })

  it('rebuilds when what is cached cannot be read, and when the cache is down', async () => {
    await cache.set(statsCacheKey('u1'), '{not json')
    expect((await loadPlayerCard(fakeDb(), 'u1', cache, now))!.userId).toBe('u1')
    const broken = { ...cache, get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') }, zrevrank: async () => null, zscore: async () => null } as unknown as MemoryCache
    expect((await loadPlayerCard(fakeDb(), 'u1', broken, now))!.userId).toBe('u1')
  })
})

describe('forViewer', () => {
  const card = { userId: 'u1', streak: { current: 5, longest: 9, freezes: 1, lastDay: '2026-10-16' } } as PlayerCard

  it('shows the owner everything, and everybody the streak of somebody who shows their activity', () => {
    expect(forViewer(card, { isOwner: true, showActivity: false })).toBe(card)
    expect(forViewer(card, { isOwner: false, showActivity: true })).toBe(card)
  })

  it('hides the streak from others when the person keeps their activity private, and nothing else', () => {
    const hidden = forViewer(card, { isOwner: false, showActivity: false })
    expect(hidden.streak).toBeNull()
    expect(hidden.userId).toBe('u1')
    expect(card.streak).not.toBeNull()
  })
})
