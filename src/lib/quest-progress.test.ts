import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db } from './events'

const grant = vi.fn()
vi.mock('@/lib/rewards', () => ({ grant: (...args: unknown[]) => grant(...args) }))
const recordReward = vi.fn()
const afterCommit = vi.fn()
vi.mock('@/lib/events', () => ({
  recordReward: (...args: unknown[]) => recordReward(...args),
  afterCommit: (...args: unknown[]) => afterCommit(...args),
}))
vi.mock('@/lib/infra/analytics', () => ({ track: vi.fn() }))
const isEnabled = vi.fn()
vi.mock('@/lib/flags', () => ({ isEnabled: (...args: unknown[]) => isEnabled(...args) }))

import { advanceQuests, readProgress } from './quest-progress'
import { currentQuests } from './quests'

const NOW = new Date('2026-10-16T10:00:00Z')

interface Row {
  id: string
  questId: string
  periodKey: string
  progress: { current: number; target: number; completed: boolean }
  completedAt: Date | null
}

function fakeTx() {
  const quests = new Map<string, string>()
  const rows = new Map<string, Row>()
  let counter = 0
  const key = (questId: string, periodKey: string) => `${questId}|${periodKey}`
  const notifications: unknown[] = []
  const tx = {
    quest: {
      upsert: vi.fn(async ({ where }: { where: { slug: string } }) => {
        if (!quests.has(where.slug)) quests.set(where.slug, `quest-${where.slug}`)
        return { id: quests.get(where.slug)! }
      }),
    },
    userQuest: {
      createMany: vi.fn(async ({ data }: { data: { questId: string; periodKey: string; progress: Row['progress'] }[] }) => {
        for (const item of data) {
          if (!rows.has(key(item.questId, item.periodKey))) {
            rows.set(key(item.questId, item.periodKey), { id: `uq-${++counter}`, questId: item.questId, periodKey: item.periodKey, progress: item.progress, completedAt: null })
          }
        }
        return { count: data.length }
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { userId_questId_periodKey: { questId: string; periodKey: string } } }) => {
        const { questId, periodKey } = where.userId_questId_periodKey
        return rows.get(key(questId, periodKey))!
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { progress: Row['progress']; completedAt?: Date } }) => {
        const row = [...rows.values()].find((entry) => entry.id === where.id)!
        row.progress = data.progress
        if (data.completedAt) row.completedAt = data.completedAt
        return row
      }),
    },
    notification: { create: vi.fn(async ({ data }: { data: unknown }) => void notifications.push(data)) },
  }
  return { tx: tx as unknown as Db, rows, notifications, raw: tx }
}

beforeEach(() => {
  isEnabled.mockReset().mockResolvedValue(true)
  grant.mockReset().mockImplementation(async (_tx, _user, _action, options) => ({ granted: true, xp: options.amount, envelope: { totalXp: 100 + options.amount } }))
  recordReward.mockReset()
  afterCommit.mockReset()
})

const dailyFor = (metric: string) => currentQuests('user-1', NOW, 'UTC').daily.quests.find((quest) => quest.metric === metric)
// user-4's week holds the five-updates quest and no daily quest asks for updates, so counting updates moves one quest only.
const weeklyFor = (metric: string, user = 'user-1') => currentQuests(user, NOW, 'UTC').weekly.quests.find((quest) => quest.metric === metric)

describe('advanceQuests', () => {
  it('moves a quest the user has by one, creating its row on the first count', async () => {
    const { tx, rows } = fakeTx()
    const quest = weeklyFor('updates', 'user-4')! // weekly-update-5
    expect(quest.target).toBe(5)
    expect(await advanceQuests(tx, 'user-4', 'updates', NOW, 'UTC')).toBe(0)
    expect([...rows.values()][0].progress).toEqual({ current: 1, target: 5, completed: false })
    expect(grant).not.toHaveBeenCalled()
  })

  it('does nothing for an action none of the user’s quests ask for', async () => {
    const { tx, rows, raw } = fakeTx()
    expect(await advanceQuests(tx, 'user-1', 'hackathons_joined', NOW, 'UTC')).toBe(0)
    expect(rows.size).toBe(0)
    expect(raw.userQuest.createMany).not.toHaveBeenCalled()
  })

  it('completes a quest when the count reaches its target, paying its XP once with the user quest as the source', async () => {
    const { tx, rows } = fakeTx()
    const quest = dailyFor('replies')! // daily-reply-1
    expect(quest.target).toBe(1)
    expect(await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')).toBe(1)
    const row = [...rows.values()].find((entry) => entry.questId === `quest-${quest.slug}`)!
    expect(row.completedAt).toEqual(NOW)
    expect(row.progress).toEqual({ current: 1, target: 1, completed: true })
    expect(grant).toHaveBeenCalledTimes(1)
    expect(grant).toHaveBeenCalledWith(tx, 'user-1', 'QUEST_COMPLETED', {
      sourceType: 'QUEST',
      sourceId: row.id,
      amount: quest.xpReward,
      description: `Completed the quest "${quest.name}"`,
      now: NOW,
    })
  })

  it('puts the completed quest in the request’s rewards, and notifies once', async () => {
    const { tx, notifications } = fakeTx()
    const quest = dailyFor('replies')!
    await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')
    expect(recordReward).toHaveBeenCalledTimes(1)
    expect(recordReward.mock.calls[0][2]).toMatchObject({ questsCompleted: [{ slug: quest.slug, name: quest.name }], xpGained: 0, totalXp: 100 + quest.xpReward })
    expect(notifications).toEqual([{ userId: 'user-1', type: 'ACHIEVEMENT', title: 'Quest complete', message: quest.name, metadata: { kind: 'QUEST_COMPLETED', slug: quest.slug, xpReward: quest.xpReward } }])
    expect(afterCommit).toHaveBeenCalledTimes(1)
  })

  it('counts up to the target over several actions and completes on the last', async () => {
    const { tx, rows } = fakeTx()
    const quest = weeklyFor('updates', 'user-4')! // 5
    const completed: number[] = []
    for (let step = 0; step < quest.target; step++) completed.push(await advanceQuests(tx, 'user-4', 'updates', NOW, 'UTC'))
    expect(completed).toEqual([0, 0, 0, 0, 1])
    expect([...rows.values()].find((entry) => entry.questId === `quest-${quest.slug}`)!.progress).toEqual({ current: 5, target: 5, completed: true })
  })

  it('stops counting a completed quest, and never pays it twice', async () => {
    const { tx, rows } = fakeTx()
    const quest = dailyFor('replies')!
    await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')
    await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')
    await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')
    expect(grant).toHaveBeenCalledTimes(1)
    expect([...rows.values()].find((entry) => entry.questId === `quest-${quest.slug}`)!.progress.current).toBe(1)
  })

  it('does not report a completion when the award itself was declined', async () => {
    grant.mockResolvedValue({ granted: false, reason: 'DUPLICATE', envelope: { totalXp: 100 } })
    const { tx, notifications } = fakeTx()
    expect(await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')).toBe(0)
    expect(recordReward).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
  })

  it('keeps a separate count for each period: yesterday’s progress is not today’s', async () => {
    const { tx, rows } = fakeTx()
    const quest = dailyFor('replies')!
    await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')
    const today = [...rows.values()].find((row) => row.questId === `quest-${quest.slug}`)!
    expect(today).toMatchObject({ periodKey: '2026-10-16', completedAt: NOW })

    // The next day is a new period: whatever it asks for starts at zero, and today's row is left as it was.
    const tomorrow = new Date('2026-10-17T10:00:00Z')
    const next = currentQuests('user-1', tomorrow, 'UTC').daily.quests[0]
    await advanceQuests(tx, 'user-1', next.metric, tomorrow, 'UTC')
    expect(today.periodKey).toBe('2026-10-16')
    expect(today.completedAt).toEqual(NOW)
    const written = [...rows.values()].filter((row) => row.periodKey === '2026-10-17')
    expect(written.length).toBeGreaterThanOrEqual(1)
    for (const row of written) expect(row.progress.current).toBe(1)
  })

  it('measures the day in the user’s time zone', async () => {
    const lateEvening = new Date('2026-10-16T20:00:00Z') // Saturday 01:30 in Kolkata
    const kolkata = fakeTx()
    const wanted = currentQuests('user-1', lateEvening, 'Asia/Kolkata').daily.quests[0]
    await advanceQuests(kolkata.tx, 'user-1', wanted.metric, lateEvening, 'Asia/Kolkata')
    const periods = new Set([...kolkata.rows.values()].map((row) => row.periodKey))
    expect(periods.has('2026-10-17')).toBe(true)
    expect(periods.has('2026-10-16')).toBe(false)
  })
})

describe('the quests flag', () => {
  it('asks the "quests" flag about this user, and counts nothing at all while it is off', async () => {
    isEnabled.mockResolvedValue(false)
    const { tx, rows, raw } = fakeTx()
    expect(await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')).toBe(0)
    expect(isEnabled).toHaveBeenCalledWith(expect.anything(), 'quests', 'user-1')
    expect(rows.size).toBe(0)
    expect(raw.quest.upsert).not.toHaveBeenCalled()
    expect(grant).not.toHaveBeenCalled()
  })

  it('counts again as soon as it is back on', async () => {
    isEnabled.mockResolvedValueOnce(false).mockResolvedValue(true)
    const { tx } = fakeTx()
    expect(await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')).toBe(0)
    expect(await advanceQuests(tx, 'user-1', 'replies', NOW, 'UTC')).toBe(1)
  })
})

describe('readProgress', () => {
  it('reads what the engine wrote, and is safe about anything else', () => {
    expect(readProgress({ current: 3, target: 5, completed: false }, 5)).toEqual({ current: 3, target: 5, completed: false })
    expect(readProgress({ current: 9, completed: true }, 5)).toEqual({ current: 5, target: 5, completed: true })
    expect(readProgress(null, 5)).toEqual({ current: 0, target: 5, completed: false })
    expect(readProgress({}, 2)).toEqual({ current: 0, target: 2, completed: false })
    expect(readProgress({ current: -4 }, 2).current).toBe(0)
    expect(readProgress({ current: 'lots' }, 2).current).toBe(0)
    expect(readProgress({ current: 2.7 }, 5).current).toBe(2)
  })
})
