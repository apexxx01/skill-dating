import { describe, it, expect } from 'vitest'
import { effectiveLevel, levelForScore, riskOf, type RiskFacts } from './risk'

const clean: RiskFacts = { collusionScore: 0, distinctReporters90d: 0, blocksReceived90d: 0, throttleHits30d: 0, velocitySignals30d: 0, hasBirthDate: true, emailVerified: true }

describe('riskOf', () => {
  it('is 0 and LOW for an account with nothing against it', () => {
    expect(riskOf(clean)).toEqual({ score: 0, level: 'LOW', factors: { collusion: 0, reports: 0, blocks: 0, throttles: 0, velocity: 0, unverified: 0 } })
  })

  it('adds each factor up to its cap', () => {
    const r = riskOf({ ...clean, distinctReporters90d: 2, blocksReceived90d: 1, throttleHits30d: 1, velocitySignals30d: 1 })
    expect(r.factors).toMatchObject({ reports: 16, blocks: 3, throttles: 2, velocity: 2 })
    expect(r.score).toBe(23)
    const maxed = riskOf({ ...clean, distinctReporters90d: 50, blocksReceived90d: 50, throttleHits30d: 50, velocitySignals30d: 50 })
    expect(maxed.factors).toMatchObject({ reports: 25, blocks: 15, throttles: 10, velocity: 10 })
  })

  it('makes a strong collusion signal alone ELEVATED, and with reports HIGH', () => {
    expect(riskOf({ ...clean, collusionScore: 100 })).toMatchObject({ score: 40, level: 'ELEVATED' })
    expect(riskOf({ ...clean, collusionScore: 100, distinctReporters90d: 4 })).toMatchObject({ score: 65, level: 'ELEVATED' })
    expect(riskOf({ ...clean, collusionScore: 100, distinctReporters90d: 4, blocksReceived90d: 2 })).toMatchObject({ score: 71, level: 'HIGH' })
  })

  it('adds a little for an unverified email and a missing date of birth', () => {
    expect(riskOf({ ...clean, hasBirthDate: false, emailVerified: false }).factors.unverified).toBe(10)
    expect(riskOf({ ...clean, hasBirthDate: false }).score).toBe(5)
  })

  it('never goes past 100', () => {
    const r = riskOf({ collusionScore: 100, distinctReporters90d: 99, blocksReceived90d: 99, throttleHits30d: 99, velocitySignals30d: 99, hasBirthDate: false, emailVerified: false })
    expect(r.score).toBe(100)
    expect(r.level).toBe('HIGH')
  })
})

describe('levels', () => {
  it('draws the lines at 40 and 70', () => {
    expect(levelForScore(39)).toBe('LOW')
    expect(levelForScore(40)).toBe('ELEVATED')
    expect(levelForScore(69)).toBe('ELEVATED')
    expect(levelForScore(70)).toBe('HIGH')
  })

  it("lets an admin's override win either way, and is LOW without a row", () => {
    expect(effectiveLevel(null)).toBe('LOW')
    expect(effectiveLevel({ level: 'HIGH', overrideLevel: null })).toBe('HIGH')
    expect(effectiveLevel({ level: 'HIGH', overrideLevel: 'LOW' })).toBe('LOW')
    expect(effectiveLevel({ level: 'LOW', overrideLevel: 'HIGH' })).toBe('HIGH')
  })
})
