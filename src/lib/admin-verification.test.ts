import { describe, it, expect } from 'vitest'
import { levelFromFlags } from './admin-verification'

const none = { isEmailVerified: false, isPhoneVerified: false, githubConnected: false, portfolioVerified: false, organizationVerified: false, identityVerified: false }

describe('levelFromFlags', () => {
  it('is the highest level the flags prove, and falls when a mark is taken back', () => {
    expect(levelFromFlags(none)).toBe('NONE')
    expect(levelFromFlags({ ...none, isEmailVerified: true })).toBe('EMAIL')
    expect(levelFromFlags({ ...none, isEmailVerified: true, organizationVerified: true })).toBe('ORGANIZATION')
    expect(levelFromFlags({ ...none, isEmailVerified: true, githubConnected: true, organizationVerified: false })).toBe('GITHUB')
    expect(levelFromFlags({ ...none, identityVerified: true })).toBe('IDENTITY')
  })
})
