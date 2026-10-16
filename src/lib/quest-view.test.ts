import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadQuests } from './quest-view'
import { currentQuests } from './quests'
import { MemoryCache } from './infra/cache.memory'
import { setCache } from './infra/cache'

const NOW = new Date('2026-10-16T10:00:00Z')

beforeEach(() => setCache(new MemoryCache()))

function dbWith(rows: { periodKey: string; slug: string; progress: unknown; completedAt: Date | null }[], flag = { key: 'quests', enabled: true, rolloutPercent: 100, allowUserIds: [] as string[] }) {
  return {
    userQuest: { findMany: vi.fn(async () => rows.map((row) => ({ periodKey: row.periodKey, progress: row.progress, completedAt: row.completedAt, quest: { slug: row.slug } }))) },
    featureFlag: { findMany: vi.fn(async () => [flag]) },
  } as never
}

describe('loadQuests', () => {
  it('lists three daily and three weekly quests with no progress for a user who has done nothing', async () => {
    const view = await loadQuests(dbWith([]), 'u1', 'UTC', NOW)
    expect(view.timezone).toBe('UTC')
    expect(view.daily.quests).toHaveLength(3)
    expect(view.weekly.quests).toHaveLength(3)
    for (const quest of [...view.daily.quests, ...view.weekly.quests]) expect(quest).toMatchObject({ current: 0, completed: false, completedAt: null })
    expect(view.daily.periodKey).toBe('2026-10-16')
    expect(view.weekly.periodKey).toBe('2026-W42')
  })

  it('says when each set resets', async () => {
    const view = await loadQuests(dbWith([]), 'u1', 'Asia/Kolkata', NOW)
    expect(view.daily.resetsAt).toBe('2026-10-16T18:30:00.000Z')
    expect(view.weekly.resetsAt).toBe('2026-10-18T18:30:00.000Z')
    expect(view.timezone).toBe('Asia/Kolkata')
  })

  it('lists the same quests the engine counts toward', async () => {
    const view = await loadQuests(dbWith([]), 'u1', null, NOW)
    const engine = currentQuests('u1', NOW, null)
    expect(view.daily.quests.map((quest) => quest.slug)).toEqual(engine.daily.quests.map((quest) => quest.slug))
    expect(view.weekly.quests.map((quest) => quest.slug)).toEqual(engine.weekly.quests.map((quest) => quest.slug))
  })

  it('shows progress and completion from the rows', async () => {
    const quests = currentQuests('u1', NOW, 'UTC')
    const done = quests.daily.quests[0]
    const part = quests.weekly.quests[0]
    const when = new Date('2026-10-16T09:00:00Z')
    const view = await loadQuests(
      dbWith([
        { periodKey: '2026-10-16', slug: done.slug, progress: { current: done.target, target: done.target, completed: true }, completedAt: when },
        { periodKey: '2026-W42', slug: part.slug, progress: { current: 2, target: part.target, completed: false }, completedAt: null },
      ]),
      'u1',
      'UTC',
      NOW
    )
    expect(view.daily.quests[0]).toMatchObject({ slug: done.slug, completed: true, completedAt: when.toISOString(), current: done.target })
    expect(view.weekly.quests[0]).toMatchObject({ slug: part.slug, completed: false, current: 2, target: part.target })
    expect(view.daily.quests[1].current).toBe(0)
  })

  it('ignores a row from another period', async () => {
    const daily = currentQuests('u1', NOW, 'UTC').daily.quests[0]
    const view = await loadQuests(dbWith([{ periodKey: '2026-10-15', slug: daily.slug, progress: { current: 1, completed: true }, completedAt: new Date() }]), 'u1', 'UTC', NOW)
    expect(view.daily.quests[0]).toMatchObject({ completed: false, current: 0 })
  })

  it('falls back to UTC for an invalid zone and says so', async () => {
    expect((await loadQuests(dbWith([]), 'u1', 'Not/AZone', NOW)).timezone).toBe('UTC')
  })

  it('says quests are on, or shows none while an operator has paused them', async () => {
    expect((await loadQuests(dbWith([]), 'u1', 'UTC', NOW)).enabled).toBe(true)

    setCache(new MemoryCache()) // the flags are cached for a short while
    const paused = await loadQuests(dbWith([], { key: 'quests', enabled: false, rolloutPercent: 100, allowUserIds: [] }), 'u1', 'UTC', NOW)
    expect(paused.enabled).toBe(false)
    expect(paused.daily.quests).toEqual([])
    expect(paused.weekly.quests).toEqual([])
    // It still says when the periods would reset, so the client can lay itself out.
    expect(paused.daily.resetsAt).toBe('2026-10-17T00:00:00.000Z')
  })

  it('is off for everybody when the flag does not exist at all', async () => {
    const db = { userQuest: { findMany: vi.fn(async () => []) }, featureFlag: { findMany: vi.fn(async () => []) } } as never
    expect((await loadQuests(db, 'u1', 'UTC', NOW)).enabled).toBe(false)
  })

  it('is on for somebody on the allowlist while the flag is otherwise off', async () => {
    const db = dbWith([], { key: 'quests', enabled: false, rolloutPercent: 100, allowUserIds: ['u1'] })
    expect((await loadQuests(db, 'u1', 'UTC', NOW)).enabled).toBe(true)
    expect((await loadQuests(db, 'u2', 'UTC', NOW)).enabled).toBe(false)
  })
})
