import { describe, it, expect } from 'vitest'
import { createFlagSchema, updateFlagSchema, flagResponse, MAX_ALLOWLIST } from './flags-admin'

describe('createFlagSchema', () => {
  it('applies the defaults: off, 100%, nobody on the allowlist', () => {
    expect(createFlagSchema.parse({ key: 'new-feed' })).toEqual({ key: 'new-feed', enabled: false, rolloutPercent: 100, allowUserIds: [] })
  })

  it('accepts a full flag', () => {
    const flag = { key: 'beta.search', description: 'New search', enabled: true, rolloutPercent: 25, allowUserIds: ['user_1', 'abc-DEF_2'] }
    expect(createFlagSchema.parse(flag)).toEqual(flag)
  })

  it('rejects a bad key', () => {
    for (const key of ['', 'A', 'Has-Capitals', 'has space', '1starts-with-digit', 'x'.repeat(65), '../etc']) {
      expect(createFlagSchema.safeParse({ key }).success, key).toBe(false)
    }
  })

  it('rejects a rollout outside 0 to 100, or that is not a whole number', () => {
    for (const rolloutPercent of [-1, 101, 12.5, '50', null]) {
      expect(createFlagSchema.safeParse({ key: 'ok-key', rolloutPercent }).success, String(rolloutPercent)).toBe(false)
    }
    expect(createFlagSchema.safeParse({ key: 'ok-key', rolloutPercent: 0 }).success).toBe(true)
    expect(createFlagSchema.safeParse({ key: 'ok-key', rolloutPercent: 100 }).success).toBe(true)
  })

  it('rejects allowlist entries that are not ids, and a list that is too long', () => {
    expect(createFlagSchema.safeParse({ key: 'ok-key', allowUserIds: ['has space'] }).success).toBe(false)
    expect(createFlagSchema.safeParse({ key: 'ok-key', allowUserIds: [''] }).success).toBe(false)
    expect(createFlagSchema.safeParse({ key: 'ok-key', allowUserIds: ['a'.repeat(65)] }).success).toBe(false)
    expect(createFlagSchema.safeParse({ key: 'ok-key', allowUserIds: Array.from({ length: MAX_ALLOWLIST + 1 }, (_, i) => `u${i}`) }).success).toBe(false)
    expect(createFlagSchema.safeParse({ key: 'ok-key', allowUserIds: Array.from({ length: MAX_ALLOWLIST }, (_, i) => `u${i}`) }).success).toBe(true)
  })

  it('rejects a description that is too long, and trims it', () => {
    expect(createFlagSchema.safeParse({ key: 'ok-key', description: 'x'.repeat(301) }).success).toBe(false)
    expect(createFlagSchema.parse({ key: 'ok-key', description: '  hi  ' }).description).toBe('hi')
  })

  it('does not let a client set fields it should not', () => {
    const parsed = createFlagSchema.parse({ key: 'ok-key', id: 'x', updatedById: 'someone', createdAt: '2020-01-01' })
    expect(parsed).not.toHaveProperty('id')
    expect(parsed).not.toHaveProperty('updatedById')
    expect(parsed).not.toHaveProperty('createdAt')
  })
})

describe('updateFlagSchema', () => {
  it('takes any subset of the fields, and none of the key', () => {
    expect(updateFlagSchema.parse({})).toEqual({})
    expect(updateFlagSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(updateFlagSchema.parse({ key: 'renamed', rolloutPercent: 10 })).toEqual({ rolloutPercent: 10 })
  })

  it('lets the description be cleared with null', () => {
    expect(updateFlagSchema.parse({ description: null })).toEqual({ description: null })
  })

  it('applies the same limits', () => {
    expect(updateFlagSchema.safeParse({ rolloutPercent: 101 }).success).toBe(false)
    expect(updateFlagSchema.safeParse({ enabled: 'yes' }).success).toBe(false)
    expect(updateFlagSchema.safeParse({ allowUserIds: ['bad id'] }).success).toBe(false)
  })
})

describe('flagResponse', () => {
  it('exposes the flag but not its database id', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    const out = flagResponse({ id: 'secret-id', key: 'k1', description: null, enabled: true, rolloutPercent: 5, allowUserIds: ['u1'], updatedById: 'admin1', createdAt: at, updatedAt: at })
    expect(out).toEqual({ key: 'k1', description: null, enabled: true, rolloutPercent: 5, allowUserIds: ['u1'], updatedById: 'admin1', createdAt: at, updatedAt: at })
  })
})
