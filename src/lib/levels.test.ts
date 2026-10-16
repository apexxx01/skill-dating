import { describe, it, expect } from 'vitest'
import { levelFor, xpForLevel, xpAtLevelStart, tierForLevel, MAX_LEVEL, POWER_LAW_LAST_LEVEL, TIERS, TIER_START_LEVEL } from './levels'

describe('xpForLevel', () => {
  const powerLaw = (level: number) => Math.round(5 * Math.pow(level, 1.85))

  it('is round(5 * n^1.85) up to level 55', () => {
    expect(xpForLevel(1)).toBe(5)
    expect(xpForLevel(2)).toBe(18)
    expect(xpForLevel(4)).toBe(65)
    expect(xpForLevel(9)).toBe(291)
    for (let level = 1; level <= POWER_LAW_LAST_LEVEL; level++) expect(xpForLevel(level)).toBe(powerLaw(level))
  })

  it('grows in a straight line from level 56: 3600, then 50 more for every level', () => {
    expect(xpForLevel(56)).toBe(3600)
    expect(xpForLevel(57)).toBe(3650)
    expect(xpForLevel(80)).toBe(4800)
    expect(xpForLevel(99)).toBe(5750)
    expect(xpForLevel(100)).toBe(5800)
    for (let level = POWER_LAW_LAST_LEVEL + 1; level < MAX_LEVEL; level++) expect(xpForLevel(level + 1) - xpForLevel(level)).toBe(50)
  })

  it('grows with every level inside each of the two parts', () => {
    for (let level = 1; level < POWER_LAW_LAST_LEVEL; level++) expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level))
    for (let level = POWER_LAW_LAST_LEVEL + 1; level < MAX_LEVEL; level++) expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level))
  })

  it('steps down once, at level 56, and never asks more than the power law would have', () => {
    expect(xpForLevel(56)).toBeLessThan(xpForLevel(55))
    for (let level = POWER_LAW_LAST_LEVEL + 1; level <= MAX_LEVEL; level++) expect(xpForLevel(level)).toBeLessThan(powerLaw(level))
  })

  it('leaves every threshold up to the start of level 56 exactly where the power law put it', () => {
    let total = 0
    for (let level = 1; level <= POWER_LAW_LAST_LEVEL; level++) {
      expect(xpAtLevelStart(level)).toBe(total)
      total += powerLaw(level)
    }
    expect(xpAtLevelStart(POWER_LAW_LAST_LEVEL + 1)).toBe(total)
  })
})

describe('xpAtLevelStart', () => {
  it('starts level 1 at zero and adds each level size', () => {
    expect(xpAtLevelStart(1)).toBe(0)
    expect(xpAtLevelStart(2)).toBe(5)
    expect(xpAtLevelStart(3)).toBe(23)
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
    expect(levelFor(0)).toEqual({ level: 1, tier: 'BRONZE', xpIntoLevel: 0, xpForNextLevel: 5, progress: 0 })
  })

  it('stays on a level until its last XP, and advances on the exact threshold', () => {
    expect(levelFor(4)).toMatchObject({ level: 1, xpIntoLevel: 4, xpForNextLevel: 5 })
    expect(levelFor(5)).toMatchObject({ level: 2, xpIntoLevel: 0, xpForNextLevel: 18, progress: 0 })
    expect(levelFor(22)).toMatchObject({ level: 2, xpIntoLevel: 17 })
    expect(levelFor(23)).toMatchObject({ level: 3, xpIntoLevel: 0 })
  })

  it('reports progress as a fraction of the level', () => {
    expect(levelFor(2).progress).toBeCloseTo(0.4)
    expect(levelFor(5 + 9).progress).toBeCloseTo(0.5, 1)
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
    expect(levelFor(4.9)).toMatchObject({ level: 1, xpIntoLevel: 4 })
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
