import { describe, it, expect } from 'vitest'
import { levelFor, xpForLevel, xpAtLevelStart, tierForLevel, MAX_LEVEL, TIERS, TIER_START_LEVEL } from './levels'

describe('xpForLevel', () => {
  it('is round(100 * n^1.5)', () => {
    expect(xpForLevel(1)).toBe(100)
    expect(xpForLevel(2)).toBe(283)
    expect(xpForLevel(4)).toBe(800)
    expect(xpForLevel(9)).toBe(2700)
    expect(xpForLevel(100)).toBe(100000)
  })

  it('grows with every level', () => {
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level))
    }
  })
})

describe('xpAtLevelStart', () => {
  it('starts level 1 at zero and adds each level size', () => {
    expect(xpAtLevelStart(1)).toBe(0)
    expect(xpAtLevelStart(2)).toBe(100)
    expect(xpAtLevelStart(3)).toBe(383)
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(xpAtLevelStart(level + 1) - xpAtLevelStart(level)).toBe(xpForLevel(level))
    }
  })

  it('clamps levels outside 1..MAX_LEVEL', () => {
    expect(xpAtLevelStart(0)).toBe(0)
    expect(xpAtLevelStart(-5)).toBe(0)
    expect(xpAtLevelStart(MAX_LEVEL + 50)).toBe(xpAtLevelStart(MAX_LEVEL))
  })
})

describe('levelFor', () => {
  it('puts a new account at level 1, no progress', () => {
    expect(levelFor(0)).toEqual({ level: 1, tier: 'BRONZE', xpIntoLevel: 0, xpForNextLevel: 100, progress: 0 })
  })

  it('stays on a level until its last XP, and advances on the exact threshold', () => {
    expect(levelFor(99)).toMatchObject({ level: 1, xpIntoLevel: 99, xpForNextLevel: 100 })
    expect(levelFor(100)).toMatchObject({ level: 2, xpIntoLevel: 0, xpForNextLevel: 283, progress: 0 })
    expect(levelFor(382)).toMatchObject({ level: 2, xpIntoLevel: 282 })
    expect(levelFor(383)).toMatchObject({ level: 3, xpIntoLevel: 0 })
  })

  it('reports progress as a fraction of the level', () => {
    expect(levelFor(50).progress).toBeCloseTo(0.5)
    expect(levelFor(100 + 283 / 2).progress).toBeCloseTo(0.5, 1)
  })

  it('agrees with the thresholds at every level boundary', () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      const start = xpAtLevelStart(level)
      expect(levelFor(start).level).toBe(level)
      expect(levelFor(start).xpIntoLevel).toBe(0)
      if (level > 1) expect(levelFor(start - 1).level).toBe(level - 1)
    }
  })

  it('has progress strictly below 1 inside every level below the top', () => {
    for (let level = 1; level < MAX_LEVEL; level++) {
      const last = levelFor(xpAtLevelStart(level + 1) - 1)
      expect(last.level).toBe(level)
      expect(last.progress).toBeLessThan(1)
      expect(last.xpIntoLevel + 1).toBe(last.xpForNextLevel)
    }
  })

  it('caps at MAX_LEVEL with nothing left to earn', () => {
    const top = xpAtLevelStart(MAX_LEVEL)
    expect(levelFor(top)).toEqual({ level: MAX_LEVEL, tier: 'MYTHIC', xpIntoLevel: 0, xpForNextLevel: 0, progress: 1 })
    const beyond = levelFor(top + 1_000_000)
    expect(beyond.level).toBe(MAX_LEVEL)
    expect(beyond.xpIntoLevel).toBe(1_000_000)
    expect(beyond.progress).toBe(1)
  })

  it('treats negative, fractional and non-finite XP safely', () => {
    expect(levelFor(-50).level).toBe(1)
    expect(levelFor(-50).xpIntoLevel).toBe(0)
    expect(levelFor(99.9)).toMatchObject({ level: 1, xpIntoLevel: 99 })
    expect(levelFor(Number.NaN).level).toBe(1)
    expect(levelFor(Number.POSITIVE_INFINITY).level).toBe(1)
  })
})

describe('tiers', () => {
  it('exports the six tiers in order with their first levels', () => {
    expect([...TIERS]).toEqual(['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MYTHIC'])
    expect(TIER_START_LEVEL).toEqual({ BRONZE: 1, SILVER: 10, GOLD: 20, PLATINUM: 35, DIAMOND: 55, MYTHIC: 80 })
  })

  it.each([
    [1, 'BRONZE'],
    [9, 'BRONZE'],
    [10, 'SILVER'],
    [19, 'SILVER'],
    [20, 'GOLD'],
    [34, 'GOLD'],
    [35, 'PLATINUM'],
    [54, 'PLATINUM'],
    [55, 'DIAMOND'],
    [79, 'DIAMOND'],
    [80, 'MYTHIC'],
    [100, 'MYTHIC'],
  ])('level %i is %s', (level, tier) => {
    expect(tierForLevel(level)).toBe(tier)
  })

  it('changes tier exactly at the tier start levels, using XP', () => {
    for (const tier of TIERS) {
      const start = TIER_START_LEVEL[tier]
      expect(levelFor(xpAtLevelStart(start)).tier).toBe(tier)
      if (start > 1) expect(levelFor(xpAtLevelStart(start) - 1).tier).not.toBe(tier)
    }
  })
})
