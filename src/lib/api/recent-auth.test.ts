import { describe, it, expect, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ clerkClient: vi.fn() }))

import { isRecentAuth } from './recent-auth'

const now = new Date('2026-10-20T12:00:00Z')

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
