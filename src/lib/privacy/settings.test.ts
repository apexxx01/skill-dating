import { describe, it, expect } from 'vitest'
import { applyFieldVisibility, privacySchema, visibilityOf } from './settings'

describe('field visibility', () => {
  it('is PUBLIC for any field not set, and ignores nonsense', () => {
    const v = visibilityOf({ bio: 'PRIVATE', website: 'SECRET' })
    expect(v.bio).toBe('PRIVATE')
    expect(v.website).toBe('PUBLIC')
    expect(visibilityOf(null).location).toBe('PUBLIC')
  })

  it('hides private fields from everyone else, and connection-only fields from strangers', () => {
    const profile = { bio: 'b', location: 'Pune', website: 'https://x.dev', name: 'Ada' }
    const visibility = visibilityOf({ bio: 'PRIVATE', location: 'CONNECTIONS' })
    expect(applyFieldVisibility(profile, visibility, { isOwner: false, connected: false })).toEqual({ bio: null, location: null, website: 'https://x.dev', name: 'Ada' })
    expect(applyFieldVisibility(profile, visibility, { isOwner: false, connected: true })).toEqual({ bio: null, location: 'Pune', website: 'https://x.dev', name: 'Ada' })
    expect(applyFieldVisibility(profile, visibility, { isOwner: true, connected: false })).toEqual(profile)
  })
})

describe('privacySchema', () => {
  it('accepts any subset of the settings and refuses unknown ones', () => {
    expect(privacySchema.safeParse({ invisibleMode: true }).success).toBe(true)
    expect(privacySchema.safeParse({ fieldVisibility: { bio: 'CONNECTIONS' } }).success).toBe(true)
    expect(privacySchema.safeParse({ fieldVisibility: { email: 'PUBLIC' } }).success).toBe(false)
    expect(privacySchema.safeParse({ whoCanMessage: 'FRIENDS' }).success).toBe(false)
    expect(privacySchema.safeParse({}).success).toBe(false)
  })
})
