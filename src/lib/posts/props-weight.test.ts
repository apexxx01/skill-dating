import { describe, it, expect } from 'vitest'
import { propWeight, type GiverFacts } from './props-weight'

const now = new Date('2026-10-18T12:00:00Z')
const daysOld = (days: number) => new Date(now.getTime() - days * 86_400_000)
const giver = (over: Partial<GiverFacts> = {}): GiverFacts => ({ tier: 'BRONZE', createdAt: daysOld(90), isEmailVerified: true, verificationLevel: 'GITHUB', ...over })

describe('propWeight', () => {
  it('is 1 for an established Bronze builder with GitHub', () => {
    expect(propWeight(giver(), now)).toBe(1)
  })

  it('grows 0.25 for each tier above Bronze', () => {
    expect(propWeight(giver({ tier: 'SILVER' }), now)).toBe(1.25)
    expect(propWeight(giver({ tier: 'GOLD' }), now)).toBe(1.5)
    expect(propWeight(giver({ tier: 'MYTHIC' }), now)).toBe(2.25)
  })

  it('counts nothing for an account the trust gate does not trust', () => {
    expect(propWeight(giver({ createdAt: daysOld(6) }), now)).toBe(0)
    expect(propWeight(giver({ createdAt: daysOld(0) }), now)).toBe(0)
    expect(propWeight(giver({ isEmailVerified: false }), now)).toBe(0)
    expect(propWeight(giver({ verificationLevel: 'NONE' }), now)).toBe(0)
    expect(propWeight(giver({ createdAt: daysOld(7) }), now)).toBeGreaterThan(0)
  })

  it('counts a young account less, up to full weight at 90 days', () => {
    const w = (days: number) => propWeight(giver({ createdAt: daysOld(days) }), now)
    expect(w(7)).toBeCloseTo(0.4 + 0.6 * (7 / 90), 2)
    expect(w(30)).toBeGreaterThan(w(7))
    expect(w(60)).toBeGreaterThan(w(30))
    expect(w(90)).toBe(1)
    expect(w(900)).toBe(1)
  })

  it('counts a verified email less than a phone, and a phone less than GitHub', () => {
    expect(propWeight(giver({ verificationLevel: 'EMAIL' }), now)).toBe(0.7)
    expect(propWeight(giver({ verificationLevel: 'PHONE' }), now)).toBe(0.85)
    expect(propWeight(giver({ verificationLevel: 'GITHUB' }), now)).toBe(1)
    expect(propWeight(giver({ verificationLevel: 'IDENTITY' }), now)).toBe(1)
  })

  it('stays within 0 and 2.25 and has at most two decimals', () => {
    for (const tier of ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MYTHIC'] as const) {
      for (const days of [0, 3, 7, 13, 45, 89, 400]) {
        for (const verificationLevel of ['NONE', 'EMAIL', 'PHONE', 'GITHUB'] as const) {
          const weight = propWeight(giver({ tier, createdAt: daysOld(days), verificationLevel }), now)
          expect(weight).toBeGreaterThanOrEqual(0)
          expect(weight).toBeLessThanOrEqual(2.25)
          expect(Math.round(weight * 100)).toBeCloseTo(weight * 100, 6)
        }
      }
    }
  })
})
