import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import type { User as ClerkUser } from '@clerk/nextjs/server'
import { testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { uniqueSuffix } from './helpers'

// Phone verification follows Clerk the way GitHub does: the lazy sync and the webhook both go through syncClerkUser, so a verified phone number on the
// Clerk account marks the local user. The Clerk instance may have phone numbers switched off, in which case nothing changes.
describe('phone verification from Clerk', () => {
  const suffix = uniqueSuffix()
  const clerkIds: string[] = []
  let syncClerkUser: typeof import('../../src/lib/user-sync').syncClerkUser
  let processClerkEvent: typeof import('../../src/lib/clerk-webhook').processClerkEvent

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    ;({ syncClerkUser } = await import('../../src/lib/user-sync'))
    ;({ processClerkEvent } = await import('../../src/lib/clerk-webhook'))
  })
  afterAll(async () => {
    await testPrisma.user.deleteMany({ where: { clerkId: { in: clerkIds } } })
  })

  function clerkUser(name: string, phones: { status: string }[] | undefined, github = false): ClerkUser {
    const clerkId = `user_phone_${suffix}_${name}`
    clerkIds.push(clerkId)
    return {
      id: clerkId,
      primaryEmailAddressId: 'e1',
      emailAddresses: [{ id: 'e1', emailAddress: `${name}.${suffix}@phone.test.dev`, verification: { status: 'verified' } }],
      phoneNumbers: phones?.map((phone, index) => ({ id: `p${index}`, phoneNumber: '+10000000000', verification: phone })),
      externalAccounts: github ? [{ provider: 'oauth_github', verification: { status: 'verified' } }] : [],
      username: `ph${suffix}${name}`,
      firstName: name,
      lastName: null,
      hasImage: false,
      imageUrl: '',
    } as unknown as ClerkUser
  }
  const stateOf = (clerkId: string) =>
    testPrisma.user.findUniqueOrThrow({ where: { clerkId }, select: { id: true, isPhoneVerified: true, githubConnected: true, verificationLevel: true } })

  it('marks a user whose Clerk account has a verified phone, lifts the level and records the verification', async () => {
    const cu = clerkUser('with', [{ status: 'verified' }])
    await syncClerkUser(cu, testPrisma)
    const row = await stateOf(cu.id)
    expect(row).toMatchObject({ isPhoneVerified: true, githubConnected: false, verificationLevel: 'PHONE' })
    const records = await testPrisma.verification.findMany({ where: { userId: row.id, type: 'PHONE' } })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'VERIFIED', provider: 'clerk' })
  })

  it('picks the phone up later, when it is verified after the account was created, without duplicating the record', async () => {
    const before = clerkUser('later', [{ status: 'unverified' }])
    await syncClerkUser(before, testPrisma)
    expect((await stateOf(before.id)).isPhoneVerified).toBe(false)
    const after = { ...before, phoneNumbers: [{ id: 'p0', verification: { status: 'verified' } }] } as unknown as ClerkUser
    await syncClerkUser(after, testPrisma)
    await syncClerkUser(after, testPrisma)
    const row = await stateOf(before.id)
    expect(row.isPhoneVerified).toBe(true)
    expect(await testPrisma.verification.count({ where: { userId: row.id, type: 'PHONE' } })).toBe(1)
  })

  it('works when phone numbers are switched off in Clerk: no list, an empty list, no change', async () => {
    for (const [name, phones] of [['off', undefined], ['empty', []]] as const) {
      const cu = clerkUser(name, phones as { status: string }[] | undefined)
      await syncClerkUser(cu, testPrisma)
      expect(await stateOf(cu.id)).toMatchObject({ isPhoneVerified: false, verificationLevel: 'EMAIL' })
    }
  })

  it('keeps GitHub as the higher level when both are present', async () => {
    const cu = clerkUser('both', [{ status: 'verified' }], true)
    await syncClerkUser(cu, testPrisma)
    expect(await stateOf(cu.id)).toMatchObject({ isPhoneVerified: true, githubConnected: true, verificationLevel: 'GITHUB' })
  })

  it('follows a webhook event the same way', async () => {
    const cu = clerkUser('hook', [{ status: 'verified' }])
    const result = await processClerkEvent(
      { type: 'user.updated', data: { id: cu.id } },
      { fetchUser: async () => cu, sync: (user) => syncClerkUser(user, testPrisma), tombstone: async () => false }
    )
    expect(result).toEqual({ status: 'synced' })
    expect((await stateOf(cu.id)).isPhoneVerified).toBe(true)
  })

  it('does not let a phone make a minor, or anyone, dating-eligible by itself: the other gates still apply', async () => {
    const cu = clerkUser('gates', [{ status: 'verified' }])
    await syncClerkUser(cu, testPrisma)
    const row = await testPrisma.user.findUniqueOrThrow({ where: { clerkId: cu.id }, select: { birthDate: true, isEmailVerified: true, isPhoneVerified: true, githubConnected: true } })
    const { datingBlockers } = await import('../../src/lib/matching/dating')
    expect(datingBlockers(row)).toEqual(['BIRTH_DATE_MISSING'])
  })
})
