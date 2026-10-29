import { describe, it, expect, vi } from 'vitest'
import { loadAchievementItems, progressOf, SECRET_DESCRIPTION, SECRET_NAME, secretPlaceholderSlug } from './achievement-catalog'
import { ACHIEVEMENT_DEFINITIONS } from './achievement-definitions'

interface Setup {
  rows?: { slug: string; name: string; description: string; icon: string | null; xpReward: number; rarity: number | null }[]
  earned?: { slug: string; earnedAt: Date; progress: unknown }[]
  counters?: Record<string, number>
  streak?: { currentStreak: number; lastStreakDay: string | null; streakFreezes?: number }
}

function fakeDb(setup: Setup = {}) {
  const today = new Date().toISOString().slice(0, 10)
  return {
    achievement: { findMany: vi.fn(async () => setup.rows ?? []) },
    userAchievement: { findMany: vi.fn(async () => (setup.earned ?? []).map((entry) => ({ earnedAt: entry.earnedAt, progress: entry.progress, achievement: { slug: entry.slug } }))) },
    userCounter: { findMany: vi.fn(async () => Object.entries(setup.counters ?? {}).map(([key, value]) => ({ key, value }))) },
    user: {
      findUnique: vi.fn(async () => ({
        xp: 0,
        timezone: null,
        currentStreak: setup.streak?.currentStreak ?? 0,
        longestStreak: setup.streak?.currentStreak ?? 0,
        lastStreakDay: setup.streak ? setup.streak.lastStreakDay ?? today : null,
        streakFreezes: setup.streak?.streakFreezes ?? 0,
        streakFreezeUsed: false,
      })),
    },
  } as never
}

const find = (items: Awaited<ReturnType<typeof loadAchievementItems>>, slug: string) => items.find((item) => item.slug === slug)!

describe('loadAchievementItems', () => {
  it('lists the whole catalog in order', async () => {
    const items = await loadAchievementItems(fakeDb(), 'u1')
    expect(items).toHaveLength(54)
    expect(items.map((item) => item.order)).toEqual(Array.from({ length: 54 }, (_, index) => index + 1))
  })

  it('masks the seven secret achievements for somebody who has not earned them, and gives nothing away', async () => {
    const items = await loadAchievementItems(fakeDb(), 'u1')
    const masked = items.filter((item) => item.masked)
    expect(masked).toHaveLength(7)
    for (const item of masked) {
      expect(item).toMatchObject({ name: SECRET_NAME, description: SECRET_DESCRIPTION, icon: null, xpReward: null, progress: null, rarity: null, secret: true, earned: false, earnedAt: null, category: 'SECRET' })
      expect(item.slug).toBe(secretPlaceholderSlug(item.order))
    }
    // Nothing about the hidden ones appears anywhere in the response.
    const text = JSON.stringify(items)
    for (const slug of ['night-owl', 'hat-trick', 'no-safety-net', 'golden-vouch', 'weekend-warrior', 'comeback-kid', 'archaeologist']) expect(text).not.toContain(slug)
    for (const slug of ['night-owl', 'hat-trick', 'no-safety-net', 'golden-vouch', 'weekend-warrior', 'comeback-kid', 'archaeologist'] as const) {
      expect(text).not.toContain(ACHIEVEMENT_DEFINITIONS[slug].name)
      expect(text).not.toContain(ACHIEVEMENT_DEFINITIONS[slug].description)
    }
  })

  it('shows a secret achievement in full once it is earned', async () => {
    const when = new Date('2026-03-10T10:00:00Z')
    const items = await loadAchievementItems(fakeDb({ earned: [{ slug: 'night-owl', earnedAt: when, progress: { current: 1, target: 1 } }] }), 'u1')
    expect(find(items, 'night-owl')).toMatchObject({ name: 'Night Owl', masked: false, earned: true, earnedAt: '2026-03-10T10:00:00.000Z', xpReward: 75, secret: true, progress: { current: 1, target: 1 } })
    expect(items.filter((item) => item.masked)).toHaveLength(6)
  })

  it('reports progress from the counters, up to the target and not past it', async () => {
    const items = await loadAchievementItems(fakeDb({ counters: { ships: 3, milestones: 400 } }), 'u1')
    expect(find(items, 'ship-5').progress).toEqual({ current: 3, target: 5 })
    expect(find(items, 'first-ship').progress).toEqual({ current: 1, target: 1 })
    expect(find(items, 'milestones-50').progress).toEqual({ current: 50, target: 50 })
    expect(find(items, 'ship-100').progress).toEqual({ current: 3, target: 100 })
    expect(find(items, 'first-project').progress).toEqual({ current: 0, target: 1 })
  })

  it('reports streak progress from the live streak, and none for one that has lapsed', async () => {
    const live = await loadAchievementItems(fakeDb({ streak: { currentStreak: 12, lastStreakDay: null } }), 'u1')
    expect(find(live, 'streak-30').progress).toEqual({ current: 12, target: 30 })
    expect(find(live, 'streak-7').progress).toEqual({ current: 7, target: 7 })
    const lapsed = await loadAchievementItems(fakeDb({ streak: { currentStreak: 12, lastStreakDay: '2020-01-01' } }), 'u1')
    expect(find(lapsed, 'streak-30').progress).toEqual({ current: 0, target: 30 })
  })

  it('keeps the bar full for an earned achievement even when the counter has gone down', async () => {
    const items = await loadAchievementItems(
      fakeDb({ earned: [{ slug: 'streak-30', earnedAt: new Date(), progress: { current: 30, target: 30 } }], streak: { currentStreak: 2, lastStreakDay: null } }),
      'u1'
    )
    expect(find(items, 'streak-30')).toMatchObject({ earned: true, progress: { current: 30, target: 30 } })
  })

  it('prefers the stored text over the definition, and reads the rarity from the stored row', async () => {
    const rows = [{ slug: 'ship-5', name: 'Fifth Ship', description: 'Edited by an operator.', icon: 'ship', xpReward: 175, rarity: 0.04 }]
    const items = await loadAchievementItems(fakeDb({ rows }), 'u1')
    expect(find(items, 'ship-5')).toMatchObject({ name: 'Fifth Ship', description: 'Edited by an operator.', xpReward: 175, rarity: 0.04 })
    expect(find(items, 'ship-25')).toMatchObject({ name: 'Shipping Machine', rarity: null })
  })

  it('marks the earned ones with the time they were earned', async () => {
    const when = new Date('2026-02-01T00:00:00Z')
    const items = await loadAchievementItems(fakeDb({ earned: [{ slug: 'first-project', earnedAt: when, progress: null }] }), 'u1')
    expect(find(items, 'first-project')).toMatchObject({ earned: true, earnedAt: '2026-02-01T00:00:00.000Z' })
    expect(items.filter((item) => item.earned)).toHaveLength(1)
  })
})

describe('progressOf', () => {
  it('has no progress to show for a secret rule', () => {
    expect(progressOf({ secret: 'comeback', target: 1 }, { ships: 5 }, 9)).toEqual({ current: 0, target: 1 })
  })
})
