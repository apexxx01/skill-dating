import { describe, it, expect } from 'vitest'
import { mergeHeatmaps } from './duo'

describe('mergeHeatmaps', () => {
  it('adds the same day up, keeps the others and sorts by date', () => {
    const mine = [{ date: '2026-10-02', xp: 10, actions: 1 }, { date: '2026-10-05', xp: 5, actions: 1 }]
    const theirs = [{ date: '2026-10-02', xp: 20, actions: 2 }, { date: '2026-10-01', xp: 7, actions: 1 }]
    expect(mergeHeatmaps(mine, theirs)).toEqual([
      { date: '2026-10-01', xp: 7, actions: 1 },
      { date: '2026-10-02', xp: 30, actions: 3 },
      { date: '2026-10-05', xp: 5, actions: 1 },
    ])
  })

  it('does not change its inputs, and is fine with nothing', () => {
    const mine = [{ date: '2026-10-02', xp: 10, actions: 1 }]
    mergeHeatmaps(mine, [{ date: '2026-10-02', xp: 1, actions: 1 }])
    expect(mine).toEqual([{ date: '2026-10-02', xp: 10, actions: 1 }])
    expect(mergeHeatmaps([], [])).toEqual([])
  })
})
