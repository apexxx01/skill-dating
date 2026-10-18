import { describe, it, expect } from 'vitest'
import { currentQuests, pickQuests, questPeriods, randomFrom, seedFrom } from './quests'
import { DAILY_QUESTS, QUESTS_PER_PERIOD, WEEKLY_QUESTS, type QuestDefinition } from './quest-definitions'

describe('seedFrom and randomFrom', () => {
  it('turn the same text into the same numbers, every time', () => {
    expect(seedFrom('user-1|2026-10-16')).toBe(seedFrom('user-1|2026-10-16'))
    const a = randomFrom(seedFrom('x'))
    const b = randomFrom(seedFrom('x'))
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('are pinned to fixed values, so a change of hash (which would reshuffle everybody) fails loudly', () => {
    expect(seedFrom('')).toBe(seedFrom(''))
    expect(seedFrom('abc')).toBe(1792905582)
    expect(randomFrom(12345)()).toBeCloseTo(0.9797282677609473, 12)
  })

  it('pin the quests of one user and period, so changing the pool or the shuffle is a decision and not an accident', () => {
    expect(pickQuests('user-1', '2026-10-16', 'DAILY').map((quest) => quest.slug)).toEqual(['daily-reply-1', 'daily-message-1', 'daily-project-2'])
    expect(pickQuests('user-1', '2026-W42', 'WEEKLY').map((quest) => quest.slug)).toEqual(['weekly-ship-1', 'weekly-ship-day', 'weekly-reply-5'])
  })

  it('give different seeds for different text and stay in [0, 1)', () => {
    expect(seedFrom('a')).not.toBe(seedFrom('b'))
    expect(seedFrom('user-1|2026-10-16')).not.toBe(seedFrom('user-1|2026-10-17'))
    const random = randomFrom(seedFrom('range'))
    for (let index = 0; index < 5000; index++) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('pickQuests', () => {
  it('gives three quests', () => {
    expect(pickQuests('u1', '2026-10-16', 'DAILY')).toHaveLength(QUESTS_PER_PERIOD)
    expect(pickQuests('u1', '2026-W42', 'WEEKLY')).toHaveLength(QUESTS_PER_PERIOD)
  })

  it('is deterministic: the same user and period always get the same quests in the same order', () => {
    const first = pickQuests('user-abc', '2026-10-16', 'DAILY').map((quest) => quest.slug)
    for (let index = 0; index < 5; index++) expect(pickQuests('user-abc', '2026-10-16', 'DAILY').map((quest) => quest.slug)).toEqual(first)
  })

  it('does not depend on the order the pool is listed in', () => {
    const forward = pickQuests('u9', '2026-10-16', 'DAILY', 3, DAILY_QUESTS).map((quest) => quest.slug)
    const reversed = pickQuests('u9', '2026-10-16', 'DAILY', 3, [...DAILY_QUESTS].reverse()).map((quest) => quest.slug)
    expect(reversed).toEqual(forward)
  })

  it('asks for three different things: never two ways of posting an update', () => {
    for (let user = 0; user < 300; user++) {
      for (const [key, type] of [['2026-10-16', 'DAILY'], ['2026-W42', 'WEEKLY']] as const) {
        const metrics = pickQuests(`user-${user}`, key, type).map((quest) => quest.metric)
        expect(new Set(metrics).size, `${user} ${key}`).toBe(3)
      }
    }
  })

  it('changes from one period to the next, and from one user to the next', () => {
    const days = Array.from({ length: 30 }, (_, index) => pickQuests('u1', `2026-10-${String(index + 1).padStart(2, '0')}`, 'DAILY').map((quest) => quest.slug).join(','))
    expect(new Set(days).size).toBeGreaterThan(20)
    const users = Array.from({ length: 30 }, (_, index) => pickQuests(`user-${index}`, '2026-10-16', 'DAILY').map((quest) => quest.slug).join(','))
    expect(new Set(users).size).toBeGreaterThan(20)
  })

  it('keeps daily and weekly quests apart: a weekly key never produces a daily quest', () => {
    for (const quest of pickQuests('u1', '2026-W42', 'WEEKLY')) expect(quest.type).toBe('WEEKLY')
    for (const quest of pickQuests('u1', '2026-10-16', 'DAILY')) expect(quest.type).toBe('DAILY')
  })

  it('offers every quest in the pool to somebody, and none disproportionately', () => {
    const counts = new Map<string, number>()
    const users = 3000
    for (let user = 0; user < users; user++) {
      for (const quest of pickQuests(`user-${user}`, '2026-10-16', 'DAILY')) counts.set(quest.slug, (counts.get(quest.slug) ?? 0) + 1)
    }
    expect(counts.size).toBe(DAILY_QUESTS.length)
    const expected = (users * QUESTS_PER_PERIOD) / DAILY_QUESTS.length
    for (const [slug, count] of counts) {
      expect(count, slug).toBeGreaterThan(expected * 0.5)
      expect(count, slug).toBeLessThan(expected * 1.6)
    }
    const weeklyCounts = new Map<string, number>()
    for (let user = 0; user < users; user++) for (const quest of pickQuests(`user-${user}`, '2026-W42', 'WEEKLY')) weeklyCounts.set(quest.slug, (weeklyCounts.get(quest.slug) ?? 0) + 1)
    expect(weeklyCounts.size).toBe(WEEKLY_QUESTS.length)
  })

  it('still fills the slots from a pool with fewer kinds of action than slots', () => {
    const pool: QuestDefinition[] = DAILY_QUESTS.filter((quest) => quest.metric === 'updates')
    const picked = pickQuests('u1', 'k', 'DAILY', 3, pool)
    expect(picked).toHaveLength(3)
    expect(new Set(picked.map((quest) => quest.slug)).size).toBe(3)
  })

  it('gives as many as there are when the pool is smaller than the request', () => {
    expect(pickQuests('u1', 'k', 'DAILY', 5, DAILY_QUESTS.slice(0, 2))).toHaveLength(2)
    expect(pickQuests('u1', 'k', 'DAILY', 3, [])).toEqual([])
  })
})

describe('questPeriods', () => {
  const now = new Date('2026-10-16T20:00:00Z') // a Friday

  it('keys the day by the local date and the week by the ISO week, in the user zone', () => {
    const utc = questPeriods(now, 'UTC')
    expect([utc.daily.key, utc.weekly.key]).toEqual(['2026-10-16', '2026-W42'])
    const kolkata = questPeriods(now, 'Asia/Kolkata') // already Saturday 01:30
    expect([kolkata.daily.key, kolkata.weekly.key]).toEqual(['2026-10-17', '2026-W42'])
    const kiritimati = questPeriods(new Date('2026-10-18T12:00:00Z'), 'Pacific/Kiritimati') // Monday there
    expect(kiritimati.weekly.key).toBe('2026-W43')
  })

  it('resets at the next local midnight and the next local Monday', () => {
    const utc = questPeriods(now, 'UTC')
    expect(utc.daily.start.toISOString()).toBe('2026-10-16T00:00:00.000Z')
    expect(utc.daily.end.toISOString()).toBe('2026-10-17T00:00:00.000Z')
    expect(utc.weekly.start.toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(utc.weekly.end.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    const kolkata = questPeriods(now, 'Asia/Kolkata')
    expect(kolkata.daily.end.toISOString()).toBe('2026-10-17T18:30:00.000Z')
    expect(kolkata.weekly.end.toISOString()).toBe('2026-10-18T18:30:00.000Z')
  })

  it('has the end of a period strictly after now, and its start at or before', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', null]) {
      const { daily, weekly } = questPeriods(now, zone)
      for (const period of [daily, weekly]) {
        expect(period.start.getTime()).toBeLessThanOrEqual(now.getTime())
        expect(period.end.getTime()).toBeGreaterThan(now.getTime())
      }
    }
  })

  it('falls back to UTC for an invalid zone', () => {
    expect(questPeriods(now, 'Not/AZone').daily.key).toBe('2026-10-16')
  })

  it('is one period right up to the last instant and a new one at the boundary', () => {
    const before = questPeriods(new Date('2026-10-16T23:59:59.999Z'), 'UTC')
    const after = questPeriods(new Date('2026-10-17T00:00:00Z'), 'UTC')
    expect(before.daily.key).toBe('2026-10-16')
    expect(after.daily.key).toBe('2026-10-17')
    expect(before.daily.end.getTime()).toBe(after.daily.start.getTime())
  })
})

describe('currentQuests', () => {
  it('combines the periods and the picks for a user', () => {
    const now = new Date('2026-10-16T08:00:00Z')
    const current = currentQuests('user-1', now, 'UTC')
    expect(current.daily.quests).toEqual(pickQuests('user-1', '2026-10-16', 'DAILY'))
    expect(current.weekly.quests).toEqual(pickQuests('user-1', '2026-W42', 'WEEKLY'))
  })

  it('keeps the weekly quests for the whole week while the daily ones change each day', () => {
    const monday = currentQuests('user-1', new Date('2026-10-12T08:00:00Z'), 'UTC')
    const friday = currentQuests('user-1', new Date('2026-10-16T08:00:00Z'), 'UTC')
    expect(friday.weekly.quests).toEqual(monday.weekly.quests)
    expect(friday.daily.quests).not.toEqual(monday.daily.quests)
  })
})
