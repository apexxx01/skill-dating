import { describe, it, expect } from 'vitest'
import { reachOf, reachTier, sparkAllowance } from './reach'

const now = new Date('2026-10-20T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const account = (over: Partial<{ isEmailVerified: boolean; ageDays: number; verificationLevel: string }> = {}) => ({
  isEmailVerified: over.isEmailVerified ?? true,
  createdAt: new Date(now.getTime() - (over.ageDays ?? 30) * DAY),
  verificationLevel: over.verificationLevel ?? 'EMAIL',
})

describe('reachTier', () => {
  it('follows the table: email, then age, then strong verification', () => {
    expect(reachTier(account({ isEmailVerified: false, verificationLevel: 'GITHUB' }), now)).toBe('UNVERIFIED')
    expect(reachTier(account({ ageDays: 2 }), now)).toBe('NEW')
    expect(reachTier(account({ ageDays: 6.9 }), now)).toBe('NEW')
    expect(reachTier(account({ ageDays: 7 }), now)).toBe('TRUSTED')
    for (const level of ['PHONE', 'GITHUB', 'PORTFOLIO', 'ORGANIZATION', 'IDENTITY']) expect(reachTier(account({ verificationLevel: level }), now)).toBe('VERIFIED')
  })
})

describe('reachOf', () => {
  it('keeps an unverified account off the public feed and to one spark a day', () => {
    expect(reachOf(account({ isEmailVerified: false }), { now })).toEqual({
      tier: 'UNVERIFIED',
      sparksPerDayCap: 1,
      canPostPublic: false,
      canComment: false,
      canHostRooms: false,
      canPostBounties: false,
    })
  })

  it('lets a new verified account post, with three sparks a day', () => {
    expect(reachOf(account({ ageDays: 1 }), { now })).toMatchObject({ tier: 'NEW', sparksPerDayCap: 3, canPostPublic: true, canComment: true, canHostRooms: false })
  })

  it('opens rooms and bounties only to strongly verified accounts', () => {
    expect(reachOf(account(), { now })).toMatchObject({ tier: 'TRUSTED', sparksPerDayCap: null, canHostRooms: false, canPostBounties: false })
    expect(reachOf(account({ verificationLevel: 'PHONE' }), { now })).toMatchObject({ tier: 'VERIFIED', canHostRooms: true, canPostBounties: true })
  })

  it('caps a high-risk account at one spark a day whatever its tier', () => {
    expect(reachOf(account({ verificationLevel: 'GITHUB' }), { now, highRisk: true }).sparksPerDayCap).toBe(1)
    expect(reachOf(account({ ageDays: 1 }), { now, highRisk: true }).sparksPerDayCap).toBe(1)
  })
})

describe('sparkAllowance', () => {
  it('is the lower of the plan limit and the reach cap', () => {
    expect(sparkAllowance(5, { sparksPerDayCap: null })).toBe(5)
    expect(sparkAllowance(5, { sparksPerDayCap: 3 })).toBe(3)
    expect(sparkAllowance(2, { sparksPerDayCap: 3 })).toBe(2)
  })
})
