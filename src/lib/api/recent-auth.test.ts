import { describe, it, expect, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ clerkClient: vi.fn() }))

import { factorAgeFromClaim, isRecentAuth } from './recent-auth'

const now = new Date('2026-10-20T12:00:00Z')

describe('factorAgeFromClaim', () => {
  it('reads the first factor age in minutes', () => {
    expect(factorAgeFromClaim([0, -1])).toBe(0)
    expect(factorAgeFromClaim([7, 3])).toBe(7)
  })

  it('gives no age for never (-1), unknown (99999, as on a session made through the backend API) or a missing claim', () => {
    expect(factorAgeFromClaim([-1, -1])).toBeNull()
    expect(factorAgeFromClaim([99999, -1])).toBeNull()
    expect(factorAgeFromClaim(undefined)).toBeNull()
    expect(factorAgeFromClaim(['3'])).toBeNull()
  })
})

describe('isRecentAuth', () => {
  it('uses the factor age from the token when there is one', () => {
    expect(isRecentAuth({ factorAgeMinutes: 3, sessionCreatedAt: null, now })).toBe(true)
    expect(isRecentAuth({ factorAgeMinutes: 10, sessionCreatedAt: null, now })).toBe(true)
    expect(isRecentAuth({ factorAgeMinutes: 11, sessionCreatedAt: now, now })).toBe(false)
  })

  it('falls back to the age of the session', () => {
    expect(isRecentAuth({ factorAgeMinutes: null, sessionCreatedAt: new Date(now.getTime() - 9 * 60_000), now })).toBe(true)
    expect(isRecentAuth({ factorAgeMinutes: null, sessionCreatedAt: new Date(now.getTime() - 11 * 60_000), now })).toBe(false)
  })

  it('refuses when nothing is known', () => {
    expect(isRecentAuth({ factorAgeMinutes: null, sessionCreatedAt: null, now })).toBe(false)
  })
})
