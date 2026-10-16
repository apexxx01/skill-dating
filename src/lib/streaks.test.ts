import { describe, it, expect } from 'vitest'
import { advanceStreak, COMEBACK_IDLE_DAYS, columnsFromStreak, effectiveStreak, MAX_STREAK_FREEZES, NEW_STREAK, streakDay, streakFromColumns, type StreakState } from './streaks'
import { addDaysToDateKey } from './time'

const D0 = '2026-03-01'
const day = (n: number) => addDaysToDateKey(D0, n)

/** Plays a list of counting days (day numbers from D0) and returns every step. */
function play(days: number[], from: StreakState = NEW_STREAK) {
  let state = from
  return days.map((n) => {
    const step = advanceStreak(state, day(n))
    state = step.state
    return step
  })
}

describe('advanceStreak', () => {
  it('starts a streak at 1 on the first counting day, and calls it an extension', () => {
    const [first] = play([0])
    expect(first.state).toEqual({ current: 1, longest: 1, lastDay: D0, freezes: 0, freezeUsedInRun: false })
    expect(first).toMatchObject({ extended: true, restarted: true, freezeUsed: false, alreadyCounted: false, idleDays: 0 })
  })

  it('counts a day once, however many actions there are on it', () => {
    const [first, second, third] = play([0, 0, 0])
    expect(first.extended).toBe(true)
    for (const again of [second, third]) {
      expect(again).toMatchObject({ extended: false, alreadyCounted: true, freezeUsed: false })
      expect(again.state.current).toBe(1)
    }
  })

  it('adds one for each consecutive day', () => {
    const steps = play([0, 1, 2, 3])
    expect(steps.map((step) => step.state.current)).toEqual([1, 2, 3, 4])
    expect(steps.slice(1).every((step) => step.extended && !step.restarted)).toBe(true)
    expect(steps[3].state.longest).toBe(4)
  })

  it('ends the streak after a missed day when no freeze is banked, and keeps the best', () => {
    const steps = play([0, 1, 2, 4])
    expect(steps[3].state).toMatchObject({ current: 1, longest: 3, lastDay: day(4) })
    expect(steps[3]).toMatchObject({ extended: true, restarted: true, freezeUsed: false, idleDays: 2 })
  })

  it('ends the streak after two or more missed days even with freezes banked', () => {
    const banked = { ...NEW_STREAK, current: 10, longest: 10, lastDay: day(0), freezes: 2 }
    const [step] = play([3], banked)
    expect(step.state).toMatchObject({ current: 1, longest: 10, freezes: 2 })
    expect(step.freezeUsed).toBe(false)
  })

  describe('freezes', () => {
    it('earns one freeze when a run reaches 7 days, and every further 7', () => {
      const steps = play(Array.from({ length: 14 }, (_, index) => index))
      expect(steps[5].state.freezes).toBe(0)
      expect(steps[6]).toMatchObject({ freezeEarned: true })
      expect(steps[6].state.freezes).toBe(1)
      expect(steps[12].state.freezes).toBe(1)
      expect(steps[13]).toMatchObject({ freezeEarned: true })
      expect(steps[13].state.freezes).toBe(2)
    })

    it('banks at most two', () => {
      const steps = play(Array.from({ length: 28 }, (_, index) => index))
      expect(steps[20].state.freezes).toBe(MAX_STREAK_FREEZES)
      expect(steps[27].state.freezes).toBe(MAX_STREAK_FREEZES)
      expect(steps[27].freezeEarned).toBe(false)
    })

    it('spends one automatically on a single missed day and carries on', () => {
      const banked = { current: 7, longest: 7, lastDay: day(6), freezes: 1, freezeUsedInRun: false }
      const [step] = play([8], banked) // day 7 was missed
      expect(step).toMatchObject({ extended: true, freezeUsed: true, restarted: false })
      expect(step.state).toMatchObject({ current: 8, freezes: 0, lastDay: day(8), freezeUsedInRun: true })
    })

    it('does not spend a freeze when nothing was missed', () => {
      const banked = { current: 3, longest: 3, lastDay: day(2), freezes: 2, freezeUsedInRun: false }
      const [step] = play([3], banked)
      expect(step.freezeUsed).toBe(false)
      expect(step.state.freezes).toBe(2)
    })

    it('can earn and spend in one step: a freeze covers the gap and day 7 earns another', () => {
      // A run of 6 whose last day was day 5; day 6 is missed and covered by the freeze, and day 7 makes the run 7.
      const banked = { current: 6, longest: 6, lastDay: day(5), freezes: 1, freezeUsedInRun: false }
      const [step] = play([7], banked)
      expect(step).toMatchObject({ freezeUsed: true, freezeEarned: true })
      expect(step.state).toMatchObject({ current: 7, freezes: 1 })
    })

    it('remembers a freeze was used in the run, and forgets it when the run starts over', () => {
      const banked = { current: 7, longest: 7, lastDay: day(6), freezes: 1, freezeUsedInRun: false }
      const used = play([8, 9], banked)
      expect(used[1].state.freezeUsedInRun).toBe(true)
      const [over] = play([20], used[1].state)
      expect(over.state.freezeUsedInRun).toBe(false)
      expect(over.restarted).toBe(true)
    })

    it('keeps the freezes it has when a streak ends', () => {
      const banked = { current: 5, longest: 5, lastDay: day(0), freezes: 2, freezeUsedInRun: false }
      const [step] = play([10], banked)
      expect(step.state.freezes).toBe(2)
    })
  })

  it('reports how long the user was away, for comeback detection', () => {
    const [after40] = play([41], { current: 4, longest: 9, lastDay: day(1), freezes: 0, freezeUsedInRun: false })
    expect(after40.idleDays).toBe(40)
    expect(after40.idleDays).toBeGreaterThanOrEqual(COMEBACK_IDLE_DAYS)
    expect(play([1])[0].idleDays).toBe(0)
  })

  it('ignores a day in the past, as when someone changes time zone', () => {
    const state = { current: 4, longest: 4, lastDay: day(10), freezes: 1, freezeUsedInRun: false }
    const [step] = play([9], state)
    expect(step).toMatchObject({ alreadyCounted: true, extended: false })
    expect(step.state).toBe(state)
  })

  it('walks across month and year ends and a leap day', () => {
    const start: StreakState = { current: 3, longest: 3, lastDay: '2027-12-31', freezes: 0, freezeUsedInRun: false }
    expect(advanceStreak(start, '2028-01-01').state.current).toBe(4)
    const leap: StreakState = { ...start, lastDay: '2028-02-28' }
    expect(advanceStreak(leap, '2028-02-29').state.current).toBe(4)
    expect(advanceStreak({ ...leap, lastDay: '2028-02-29' }, '2028-03-01').state.current).toBe(4)
  })
})

describe('effectiveStreak', () => {
  const state = { current: 12, longest: 20, lastDay: '2026-03-10', freezes: 0, freezeUsedInRun: false }

  it('is the stored streak today and yesterday: it can still be kept alive', () => {
    expect(effectiveStreak(state, '2026-03-10')).toBe(12)
    expect(effectiveStreak(state, '2026-03-11')).toBe(12)
  })

  it('is zero once a day was missed and there is nothing to cover it', () => {
    expect(effectiveStreak(state, '2026-03-12')).toBe(0)
    expect(effectiveStreak(state, '2026-04-01')).toBe(0)
  })

  it('survives exactly one missed day when a freeze is banked', () => {
    const frozen = { ...state, freezes: 1 }
    expect(effectiveStreak(frozen, '2026-03-12')).toBe(12)
    expect(effectiveStreak(frozen, '2026-03-13')).toBe(0)
  })

  it('is zero for a user who never had a streak', () => {
    expect(effectiveStreak(NEW_STREAK, '2026-03-10')).toBe(0)
  })
})

describe('columns', () => {
  it('round-trips the User columns', () => {
    const state = { current: 5, longest: 9, lastDay: '2026-03-10', freezes: 2, freezeUsedInRun: true }
    expect(streakFromColumns(columnsFromStreak(state))).toEqual(state)
    expect(columnsFromStreak(state)).toEqual({ currentStreak: 5, longestStreak: 9, lastStreakDay: '2026-03-10', streakFreezes: 2, streakFreezeUsed: true })
  })

  it('names the day in the user time zone', () => {
    const instant = new Date('2026-03-10T20:00:00Z')
    expect(streakDay(instant, 'UTC')).toBe('2026-03-10')
    expect(streakDay(instant, 'Asia/Kolkata')).toBe('2026-03-11')
    expect(streakDay(instant, null)).toBe('2026-03-10')
  })
})
