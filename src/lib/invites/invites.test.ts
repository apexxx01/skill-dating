import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/env', () => ({ env: {} }))

const { isUsable } = await import('./invites')

const NOW = new Date('2026-10-23T12:00:00Z')
const good = { disabledAt: null, expiresAt: null, maxUses: null, uses: 0 }

describe('isUsable', () => {
  it('accepts a code that is on, unexpired and not used up, with or without a limit', () => {
    expect(isUsable(good, NOW)).toBe(true)
    expect(isUsable({ ...good, maxUses: 5, uses: 4, expiresAt: new Date('2026-10-24T00:00:00Z') }, NOW)).toBe(true)
  })

  it('refuses a code that was switched off, has expired (at the instant itself too) or reached its limit', () => {
    expect(isUsable({ ...good, disabledAt: new Date('2026-10-01T00:00:00Z') }, NOW)).toBe(false)
    expect(isUsable({ ...good, expiresAt: NOW }, NOW)).toBe(false)
    expect(isUsable({ ...good, expiresAt: new Date('2026-10-22T00:00:00Z') }, NOW)).toBe(false)
    expect(isUsable({ ...good, maxUses: 5, uses: 5 }, NOW)).toBe(false)
  })
})
