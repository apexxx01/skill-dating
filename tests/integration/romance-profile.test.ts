import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, removePeople } from './matching-fixtures'
import { makeRomancePerson } from './romance-fixtures'
import { ROMANCE_MODE_LABEL } from '../../src/lib/romance/config'
import versions from '../../src/config/legal-versions.json'

// The romance profile: opt-in, 18+, verified, work first with the private filters underneath, and left again at any time.
describe('the romance profile', () => {
  const suffix = uniqueSuffix()
  const tag = `rp${suffix}`
  let n = 0

  const profile = {
    promptObsessed: 'Distributed systems that fail gracefully, and the people who debug them at 3am.',
    promptBuild: 'A small open source tool that makes grid-scale batteries easier to schedule.',
    promptWeekend: 'Ship a tiny weekend project together, then eat way too much street food.',
    ambition: 3,
    direction: 'founder',
    rhythm: 'night-owl',
    obsessions: ['Climate Tech', 'rust'],
    gender: 'WOMAN',
    interestedIn: ['MAN', 'NON_BINARY'],
    ageMin: 26,
    ageMax: 38,
    scope: 'COUNTRY',
  }

  // A profile that asks nothing of a person's place on file, for the tests of the gate.
  const anywhere = { ...profile, scope: 'ANYWHERE' }

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 180_000)

  async function user(over: { birthDate?: string | null; verified?: boolean; phone?: boolean; github?: boolean; countryCode?: string; cityKey?: string; consent?: boolean } = {}): Promise<TestUser> {
    const name = `${tag}u${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    await testPrisma.user.update({
      where: { id: u.userId },
      data: {
        isEmailVerified: over.verified ?? true,
        isPhoneVerified: over.phone ?? true,
        githubConnected: over.github ?? false,
        birthDate: over.birthDate === undefined ? new Date(`${bornYearsAgo(30)}T00:00:00Z`) : over.birthDate ? new Date(`${over.birthDate}T00:00:00Z`) : null,
      },
    })
    if (over.countryCode || over.cityKey) await testPrisma.profile.create({ data: { userId: u.userId, countryCode: over.countryCode ?? null, cityKey: over.cityKey ?? null, city: over.cityKey ?? null } })
    // The mode needs explicit consent; most tests here are about something else, so it is given up front.
    if (over.consent !== false) await testPrisma.consentRecord.create({ data: { userId: u.userId, type: 'ROMANCE_MODE', version: versions.ROMANCE_MODE, source: 'api' } })
    return u
  }
  const get = (u: TestUser | null) => req(u?.jar ?? null, 'GET', '/api/romance/profile')
  const put = (u: TestUser | null, body: unknown) => req(u?.jar ?? null, 'PUT', '/api/romance/profile', body)

  it('needs a signed-in user', async () => {
    expect((await get(null)).status).toBe(401)
    expect((await put(null, profile)).status).toBe(401)
    expect((await req(null, 'DELETE', '/api/romance/profile')).status).toBe(401)
  })

  describe('consent: the mode handles special-category data', () => {
    it('needs explicit consent to the mode before it can be turned on', async () => {
      const u = await user({ consent: false })
      const refused = await put(u, anywhere)
      expect(refused.status).toBe(403)
      expect(refused.data.error.code).toBe('ROMANCE_CONSENT_REQUIRED')
      expect(refused.data.error.details.consent).toEqual({ type: 'ROMANCE_MODE', version: versions.ROMANCE_MODE })
      expect((await req(u.jar, 'POST', '/api/users/me/consents', { type: 'ROMANCE_MODE', version: '2000-01-01' })).data.error.code).toBe('CONSENT_VERSION_UNKNOWN')
      const granted = await req(u.jar, 'POST', '/api/users/me/consents', { type: 'ROMANCE_MODE', version: versions.ROMANCE_MODE, source: 'romance-optin' })
      expect(granted.status).toBe(201)
      expect(granted.data.consent).toMatchObject({ type: 'ROMANCE_MODE', current: true })
      expect((await put(u, anywhere)).status).toBe(201)
    }, 60_000)

    it('turns the mode off and deletes its data when consent is withdrawn, keeping the record of both', async () => {
      const u = await user()
      expect((await put(u, anywhere)).status).toBe(201)
      const withdrawn = await req(u.jar, 'DELETE', '/api/users/me/consents/ROMANCE_MODE')
      expect(withdrawn.status).toBe(200)
      expect(withdrawn.data.consent).toMatchObject({ current: false })
      expect(await testPrisma.romanceProfile.count({ where: { userId: u.userId } })).toBe(0)
      const records = await testPrisma.consentRecord.findMany({ where: { userId: u.userId, type: 'ROMANCE_MODE' } })
      expect(records).toHaveLength(1)
      expect(records[0].withdrawnAt).not.toBeNull()
      expect((await put(u, anywhere)).data.error.code).toBe('ROMANCE_CONSENT_REQUIRED')
      expect((await req(u.jar, 'DELETE', '/api/users/me/consents/TERMS')).status).toBe(400)
    }, 60_000)
  })

  describe('the gate: 18 or older, verified', () => {
    it('is refused without a date of birth, whatever else is verified', async () => {
      const u = await user({ birthDate: null, phone: true, github: true })
      const res = await put(u, anywhere)
      expect(res.status).toBe(403)
      expect(res.data.error.code).toBe('DATING_BIRTH_DATE_REQUIRED')
      expect(res.data.error.details.blockers).toContain('BIRTH_DATE_MISSING')
      expect(res.data.error.message).toContain(ROMANCE_MODE_LABEL)
      expect(await testPrisma.romanceProfile.count({ where: { userId: u.userId } })).toBe(0)
    }, 60_000)

    it('is refused to anyone under 18, to the day, and to minors', async () => {
      const dayShort = await user({ birthDate: bornYearsAgo(18, -1) })
      const minor = await user({ birthDate: bornYearsAgo(17) })
      const child = await user({ birthDate: bornYearsAgo(12) })
      for (const refused of [dayShort, minor, child]) {
        const res = await put(refused, anywhere)
        expect(res.status).toBe(403)
        expect(res.data.error.code).toBe('DATING_UNDERAGE')
        expect(await testPrisma.romanceProfile.count({ where: { userId: refused.userId } })).toBe(0)
      }
    }, 90_000)

    it('is allowed from the day someone turns 18', async () => {
      const adult = await user({ birthDate: bornYearsAgo(18) })
      expect((await put(adult, anywhere)).status).toBe(201)
    }, 60_000)

    it('needs a verified email and a verified phone or a connected GitHub account, and either of the last two is enough', async () => {
      const unverified = await user({ verified: false })
      expect((await put(unverified, anywhere)).data.error.code).toBe('DATING_VERIFICATION_REQUIRED')
      const neither = await user({ phone: false, github: false })
      const refused = await put(neither, anywhere)
      expect(refused.data.error.code).toBe('DATING_VERIFICATION_REQUIRED')
      expect(refused.data.error.details.blockers).toEqual(['NO_PHONE_OR_GITHUB'])
      expect((await put(await user({ phone: true, github: false }), anywhere)).status).toBe(201)
      expect((await put(await user({ phone: false, github: true }), anywhere)).status).toBe(201)
    }, 90_000)

    it('tells the owner what stands in the way, on the read', async () => {
      const u = await user({ birthDate: null, phone: false })
      const res = await get(u)
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ modeLabel: ROMANCE_MODE_LABEL, exists: false, profile: null, photos: [] })
      expect(res.data.eligibility).toEqual({ eligible: false, blockers: ['BIRTH_DATE_MISSING', 'NO_PHONE_OR_GITHUB'], minAge: 18 })
      expect(res.data.options.limits).toMatchObject({ minAge: 18, maxInboxEndorsements: 5, maxPhotos: 6 })
      expect((await get(await user())).data.eligibility.eligible).toBe(true)
    }, 60_000)
  })

  describe('saving and reading', () => {
    it('creates the profile (201), replaces it (200) and shows the owner everything, the private filters under one key', async () => {
      const u = await user({ countryCode: 'IN' })
      const created = await put(u, profile)
      expect(created.status).toBe(201)
      expect(created.data.exists).toBe(true)
      expect(created.data.profile).toMatchObject({
        promptObsessed: profile.promptObsessed,
        ambition: 3,
        ambitionLabel: 'Driven',
        direction: 'founder',
        rhythm: 'night-owl',
        obsessions: ['climate tech', 'rust'],
        paused: false,
        private: { gender: 'WOMAN', genderSelfDescribe: null, interestedIn: ['MAN', 'NON_BINARY'], ageMin: 26, ageMax: 38, scope: 'COUNTRY', minEndorsements: 0 },
      })
      const again = await put(u, { ...profile, ambition: 4, minEndorsements: 3, paused: true })
      expect(again.status).toBe(200)
      expect(again.data.profile).toMatchObject({ ambition: 4, ambitionLabel: 'All in', paused: true, private: { minEndorsements: 3 } })
      expect(await testPrisma.romanceProfile.count({ where: { userId: u.userId } })).toBe(1)
      expect((await get(u)).data.profile.private.minEndorsements).toBe(3)
    }, 60_000)

    it('is one person\'s own: another person\'s read shows their own profile, never that one', async () => {
      const a = await user({ countryCode: 'IN' })
      const b = await user()
      await put(a, { ...profile, promptObsessed: 'Only A knows how obsessed A is with compilers and parsers.' })
      const theirs = await get(b)
      expect(theirs.data.exists).toBe(false)
      expect(JSON.stringify(theirs.data)).not.toContain('Only A knows')
    }, 60_000)

    it('refuses what the form should not have sent, with the fields named', async () => {
      const u = await user({ countryCode: 'IN' })
      const bad: [string, Record<string, unknown>][] = [
        ['promptObsessed', { promptObsessed: 'too short' }],
        ['ambition', { ambition: 5 }],
        ['direction', { direction: 'tycoon' }],
        ['rhythm', { rhythm: 'afternoon' }],
        ['gender', { gender: 'ROBOT' }],
        ['interestedIn', { interestedIn: [] }],
        ['ageMin', { ageMin: 17 }],
        ['ageMax', { ageMin: 30, ageMax: 29 }],
        ['scope', { scope: 'PLANET' }],
        ['minEndorsements', { minEndorsements: 6 }],
        ['genderSelfDescribe', { gender: 'SELF_DESCRIBED' }],
        ['obsessions', { obsessions: ['a', 'b'] }],
      ]
      for (const [field, over] of bad) {
        const res = await put(u, { ...profile, ...over })
        expect(res.status, field).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
        expect(Object.keys(res.data.error.details).join(), field).toContain(field === 'ageMax' ? 'ageMax' : field)
      }
      expect((await put(u, { ...profile, photos: [] })).status).toBe(400)
      expect(await testPrisma.romanceProfile.count({ where: { userId: u.userId } })).toBe(0)
    }, 90_000)

    it('asks for a city or a country on file before it takes a scope that needs one', async () => {
      const bare = await user()
      const city = await put(bare, { ...profile, scope: 'CITY' })
      expect(city.status).toBe(400)
      expect(city.data.error.details.scope[0]).toContain('city')
      expect((await put(bare, { ...profile, scope: 'COUNTRY' })).data.error.details.scope[0]).toContain('country')
      expect((await put(bare, { ...profile, scope: 'ANYWHERE' })).status).toBe(201)
      const placed = await user({ countryCode: 'IN', cityKey: 'pune' })
      expect((await put(placed, { ...profile, scope: 'CITY' })).status).toBe(201)
    }, 60_000)

    it('takes a self-description only in the person\'s own words', async () => {
      const u = await user({ countryCode: 'IN' })
      const res = await put(u, { ...profile, gender: 'SELF_DESCRIBED', genderSelfDescribe: 'agender', interestedIn: ['SELF_DESCRIBED'] })
      expect(res.status).toBe(201)
      expect(res.data.profile.private).toMatchObject({ gender: 'SELF_DESCRIBED', genderSelfDescribe: 'agender' })
      const back = await put(u, { ...profile, gender: 'MAN', genderSelfDescribe: null })
      expect(back.data.profile.private.genderSelfDescribe).toBeNull()
    }, 60_000)
  })

  describe('leaving', () => {
    it('removes the profile, its drops and its pending sparks, and ends the open romance matches for good, silently', async () => {
      const leaver = await makeRomancePerson({ tag })
      const other = await makeRomancePerson({ tag, gender: 'MAN', interestedIn: ['WOMAN'] })
      const [a, b] = leaver.id < other.id ? [leaver.id, other.id] : [other.id, leaver.id]
      const conversation = await testPrisma.conversation.create({ data: { type: 'DIRECT', members: { create: [{ userId: a }, { userId: b }] } } })
      const match = await testPrisma.match.create({ data: { userAId: a, userBId: b, userARole: 'DATING', userBRole: 'DATING', connectionType: 'DATING', conversationId: conversation.id } })
      await testPrisma.revealRequest.create({ data: { matchId: match.id, requesterId: leaver.id, status: 'ACCEPTED' } })
      await testPrisma.romanceDrop.create({ data: { userId: other.id, candidateId: leaver.id, score: 70, weekKey: '2026-W40', expiresAt: new Date(Date.now() + 86_400_000) } })
      await testPrisma.spark.create({ data: { fromId: leaver.id, toId: other.id, connectionType: 'DATING', opener: 'x'.repeat(40), openerHash: `rp${suffix}`, status: 'PENDING' } })
      const before = await testPrisma.notification.count({ where: { userId: { in: [leaver.id, other.id] } } })

      // Through the route: join, then leave.
      const me = await user({ countryCode: 'IN' })
      expect((await put(me, profile)).status).toBe(201)
      expect((await req(me.jar, 'DELETE', '/api/romance/profile')).data).toEqual({ left: true, hadProfile: true, matchesEnded: 0 })
      expect(await testPrisma.romanceProfile.count({ where: { userId: me.userId } })).toBe(0)

      // Now the person with the match, through the library the route uses.
      const { leaveRomance } = await import('../../src/lib/romance/lifecycle')
      const { MemoryStorage } = await import('../../src/lib/infra/storage.memory')
      const removal = await leaveRomance(testPrisma, new MemoryStorage(), leaver.id)
      expect(removal).toMatchObject({ hadProfile: true, matchesEnded: 1 })
      expect(await testPrisma.romanceProfile.count({ where: { userId: leaver.id } })).toBe(0)
      expect(await testPrisma.romanceDrop.count({ where: { OR: [{ userId: leaver.id }, { candidateId: leaver.id }] } })).toBe(0)
      expect(await testPrisma.spark.count({ where: { fromId: leaver.id, connectionType: 'DATING' } })).toBe(0)
      const ended = await testPrisma.match.findUniqueOrThrow({ where: { id: match.id } })
      expect(ended).toMatchObject({ endedById: leaver.id, endReason: 'UNMATCHED' })
      expect(ended.endedAt).not.toBeNull()
      expect((await testPrisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).closedAt).not.toBeNull()
      expect((await testPrisma.revealRequest.findUniqueOrThrow({ where: { matchId: match.id } })).status).toBe('REVOKED')
      // Silent: nobody is told.
      expect(await testPrisma.notification.count({ where: { userId: { in: [leaver.id, other.id] } } })).toBe(before)
      // The other person's profile is untouched.
      expect(await testPrisma.romanceProfile.count({ where: { userId: other.id } })).toBe(1)
    }, 90_000)

    it('is harmless to leave twice, or without ever having joined', async () => {
      const u = await user()
      const res = await req(u.jar, 'DELETE', '/api/romance/profile')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ left: true, hadProfile: false, matchesEnded: 0 })
    }, 60_000)

    it('happens when an admin corrects a date of birth to 17: the mode is 18+', async () => {
      const admin = await user()
      await promoteToAdmin(admin.userId)
      const target = await makeRomancePerson({ tag })
      const res = await req(admin.jar, 'POST', `/api/admin/users/${target.id}/birthdate`, { birthDate: bornYearsAgo(17), reason: 'A parent wrote in with the right date.' })
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ ageBand: 'MINOR', isMinor: true })
      expect(await testPrisma.romanceProfile.count({ where: { userId: target.id } })).toBe(0)
    }, 60_000)

    it('happens when the account is deleted', async () => {
      const { tombstoneClerkUser } = await import('../../src/lib/user-sync')
      const gone = await makeRomancePerson({ tag })
      await testPrisma.user.update({ where: { id: gone.id }, data: { clerkId: `user_rp_${suffix}` } })
      await testPrisma.spark.create({ data: { fromId: gone.id, toId: (await makeRomancePerson({ tag })).id, connectionType: 'DATING', opener: 'y'.repeat(40), openerHash: `rpg${suffix}`, status: 'PENDING' } })
      expect(await tombstoneClerkUser(`user_rp_${suffix}`, testPrisma)).toBe(true)
      expect(await testPrisma.romanceProfile.count({ where: { userId: gone.id } })).toBe(0)
      expect(await testPrisma.spark.count({ where: { fromId: gone.id } })).toBe(0)
    }, 60_000)
  })
})
