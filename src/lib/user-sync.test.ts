import { describe, it, expect } from 'vitest'
import type { User as ClerkUser } from '@clerk/nextjs/server'
import { extractClerkFacts } from './user-sync'

function clerkUser(over: Record<string, unknown> = {}): ClerkUser {
  return {
    id: 'user_1',
    primaryEmailAddressId: 'e1',
    emailAddresses: [{ id: 'e1', emailAddress: 'A@Example.com', verification: { status: 'verified' } }],
    phoneNumbers: [],
    externalAccounts: [],
    username: 'ada',
    firstName: 'Ada',
    lastName: 'L',
    hasImage: false,
    imageUrl: '',
    ...over,
  } as unknown as ClerkUser
}

describe('extractClerkFacts: phone', () => {
  it('reads a verified phone number', () => {
    const facts = extractClerkFacts(clerkUser({ phoneNumbers: [{ id: 'p1', phoneNumber: '+10000000000', verification: { status: 'verified' } }] }))
    expect(facts.phoneVerified).toBe(true)
  })

  it('does not count a phone that is not verified', () => {
    expect(extractClerkFacts(clerkUser({ phoneNumbers: [{ id: 'p1', verification: { status: 'unverified' } }] })).phoneVerified).toBe(false)
    expect(extractClerkFacts(clerkUser({ phoneNumbers: [{ id: 'p1', verification: null }] })).phoneVerified).toBe(false)
  })

  it('counts any verified number, not only the primary one', () => {
    const facts = extractClerkFacts(
      clerkUser({ phoneNumbers: [{ id: 'p1', verification: { status: 'unverified' } }, { id: 'p2', verification: { status: 'verified' } }] })
    )
    expect(facts.phoneVerified).toBe(true)
  })

  it('handles an instance with phone numbers switched off: an empty list, or none at all', () => {
    expect(extractClerkFacts(clerkUser({ phoneNumbers: [] })).phoneVerified).toBe(false)
    expect(extractClerkFacts(clerkUser({ phoneNumbers: undefined })).phoneVerified).toBe(false)
  })

  it('leaves the other facts as they were', () => {
    const facts = extractClerkFacts(clerkUser({ externalAccounts: [{ provider: 'oauth_github', verification: { status: 'verified' } }] }))
    expect(facts).toMatchObject({ email: 'a@example.com', emailVerified: true, githubConnected: true, phoneVerified: false, username: 'ada' })
  })
})
