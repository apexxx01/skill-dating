import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL, INTEGRATION_BASE_URL } from './config'
import { bornYearsAgo } from './matching-fixtures'
import versions from '../../src/config/legal-versions.json'

// Privacy (docs/PRIVACY.md): settings in one place, passport field visibility, invisible mode, the data export with its signed link, consent records and
// re-consent, retention, and account deletion through the data inventory.
describe('privacy', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let ada: TestUser
  let ben: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`pva${suffix}@test.dev`, `pva${suffix}`)
    await promoteToAdmin(admin.userId)
    ada = await registerAndLogin(`pvx${suffix}@test.dev`, `pvx${suffix}`)
    ben = await registerAndLogin(`pvy${suffix}@test.dev`, `pvy${suffix}`)
  }, 120_000)

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('keeps the privacy settings in one place', async () => {
    const before = await req(ada.jar, 'GET', '/api/users/me/privacy')
    expect(before.data).toMatchObject({ hideFromLeaderboards: false, invisibleMode: false, whoCanMessage: 'EVERYONE', matchingPaused: false })
    expect(before.data.fieldVisibility.bio).toBe('PUBLIC')
    const saved = await req(ada.jar, 'PATCH', '/api/users/me/privacy', { fieldVisibility: { bio: 'PRIVATE', location: 'CONNECTIONS' }, hideFromRecruiters: true })
    expect(saved.data).toMatchObject({ hideFromRecruiters: true, fieldVisibility: { bio: 'PRIVATE', location: 'CONNECTIONS', website: 'PUBLIC' } })
    expect((await req(ada.jar, 'PATCH', '/api/users/me/privacy', { fieldVisibility: { email: 'PUBLIC' } })).status).toBe(400)
  })

  it('has a "show my cards on the web" switch: on for an adult, never on for a minor or an account with no date of birth', async () => {
    const name = `pvc${suffix}`
    const person = await registerAndLogin(`${name}@test.dev`, name)
    const username = (await testPrisma.user.findUniqueOrThrow({ where: { id: person.userId } })).username
    const setBirth = (years: number | null) => testPrisma.user.update({ where: { id: person.userId }, data: { birthDate: years === null ? null : new Date(`${bornYearsAgo(years, 40)}T00:00:00Z`) } })
    const card = async () => (await fetch(`${INTEGRATION_BASE_URL}/api/og/passport/${username}`, { headers: { 'x-forwarded-for': person.jar.ip } })).status

    // No date of birth, then a minor: it reads off, cannot be turned on, can always be turned off, and no card is drawn.
    for (const years of [null, 16, 17]) {
      await setBirth(years)
      expect((await req(person.jar, 'GET', '/api/users/me/privacy')).data, String(years)).toMatchObject({ showCardsOnWeb: false, cardsAvailable: false })
      const refused = await req(person.jar, 'PATCH', '/api/users/me/privacy', { showCardsOnWeb: true })
      expect(refused.status).toBe(400)
      expect(refused.data.error.code).toBe('CARDS_NOT_AVAILABLE')
      expect((await req(person.jar, 'PATCH', '/api/users/me/privacy', { showCardsOnWeb: false })).data).toMatchObject({ showCardsOnWeb: false, cardsAvailable: false })
      expect(await card()).toBe(404)
    }

    // An adult: on by default, and theirs to switch.
    await setBirth(30)
    await testPrisma.profile.update({ where: { userId: person.userId }, data: { showCardsOnWeb: true } })
    expect((await req(person.jar, 'GET', '/api/users/me/privacy')).data).toMatchObject({ showCardsOnWeb: true, cardsAvailable: true })
    expect(await card()).toBe(200)
    expect((await req(person.jar, 'PATCH', '/api/users/me/privacy', { showCardsOnWeb: false })).data).toMatchObject({ showCardsOnWeb: false, cardsAvailable: true })
    expect(await card()).toBe(404)
    expect((await req(person.jar, 'PATCH', '/api/users/me/privacy', { showCardsOnWeb: true })).data).toMatchObject({ showCardsOnWeb: true })
    expect(await card()).toBe(200)
  })

  it('applies field visibility on the passport: private to everyone else, connection-only to strangers', async () => {
    await testPrisma.user.update({ where: { id: ada.userId }, data: { bio: 'Secret bio', location: 'Pune', website: 'https://ada.dev' } })
    const seen = await req(ben.jar, 'GET', `/api/users/${ada.userId}`)
    expect(seen.data).toMatchObject({ bio: null, location: null, website: 'https://ada.dev' })
    const own = await req(ada.jar, 'GET', `/api/users/${ada.userId}`)
    expect(own.data).toMatchObject({ bio: 'Secret bio', location: 'Pune' })
    await testPrisma.connection.create({ data: { senderId: ben.userId, receiverId: ada.userId, status: 'ACCEPTED' } })
    expect((await req(ben.jar, 'GET', `/api/users/${ada.userId}`)).data).toMatchObject({ bio: null, location: 'Pune' })
  })

  it('leaves an invisible person out of people search', async () => {
    const search = () => req(ben.jar, 'GET', `/api/users?search=pvx${suffix}`)
    expect((await search()).data.users.map((u: any) => u.id)).toContain(ada.userId)
    await req(ada.jar, 'PATCH', '/api/users/me/privacy', { invisibleMode: true })
    expect((await search()).data.users.map((u: any) => u.id)).not.toContain(ada.userId)
    await req(ada.jar, 'PATCH', '/api/users/me/privacy', { invisibleMode: false })
  })

  it('exports everything held about the person, through a signed link, without other people’s secrets', async () => {
    await req(ben.jar, 'POST', '/api/reports', { reportedId: ada.userId, reason: 'SPAM', description: 'from ben' })
    expect((await req(ada.jar, 'GET', '/api/users/me/export')).data.error.code).toBe('EXPORT_NOT_FOUND')
    const asked = await req(ada.jar, 'POST', '/api/users/me/export')
    expect(asked.status).toBe(202)
    // The job runs in the server's own queue; wait for it.
    let latest: any
    for (let i = 0; i < 40; i++) {
      latest = await req(ada.jar, 'GET', '/api/users/me/export')
      if (latest.data.export?.status === 'READY') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(latest.data.export).toMatchObject({ status: 'READY' })
    const url = new URL(latest.data.export.downloadUrl)
    expect(url.origin).toBe(INTEGRATION_BASE_URL)
    const download = await fetch(url, { headers: { authorization: `Bearer ${await ada.jar.token()}`, 'x-forwarded-for': ada.jar.ip } })
    expect(download.status).toBe(200)
    const file = await download.json()
    expect(file).toMatchObject({ format: 'skill-dating-export', userId: ada.userId })
    expect(file.data.User).toMatchObject({ id: ada.userId, bio: 'Secret bio' })
    expect(file.data.User).not.toHaveProperty('passwordHash')
    expect(file.data.Report[0]).toMatchObject({ reportedId: ada.userId, reason: 'SPAM' })
    expect(file.data.Report[0]).not.toHaveProperty('reporterId')
    // Somebody else cannot read the file.
    const stolen = await fetch(url, { headers: { authorization: `Bearer ${await ben.jar.token()}`, 'x-forwarded-for': ben.jar.ip } })
    expect(stolen.status).toBe(403)
    expect(await testPrisma.notification.count({ where: { userId: ada.userId, title: 'Your data export is ready' } })).toBe(1)
  })

  it('removes export files after 24 hours, with the rest of the retention rules', async () => {
    await testPrisma.dataExport.updateMany({ where: { userId: ada.userId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await testPrisma.productEvent.create({ data: { name: 'old_event', userId: ada.userId, createdAt: new Date(Date.now() - 400 * 86_400_000) } })
    const run = await req(admin.jar, 'POST', '/api/admin/jobs/privacy/retention', {})
    expect(run.status).toBe(200)
    expect(await testPrisma.dataExport.count({ where: { userId: ada.userId, status: 'EXPIRED' } })).toBe(1)
    expect(await testPrisma.productEvent.count({ where: { name: 'old_event', userId: ada.userId } })).toBe(0)
    expect((await req(ada.jar, 'GET', '/api/users/me/export')).data.error.code).toBe('EXPORT_EXPIRED')
  })

  it('records consent, and asks for it again when the version is newer', async () => {
    const states = await req(ada.jar, 'GET', '/api/users/me/consents')
    expect(states.data.required).toEqual(['TERMS', 'PRIVACY'])
    for (const type of ['TERMS', 'PRIVACY']) expect((await req(ada.jar, 'POST', '/api/users/me/consents', { type, version: versions[type as 'TERMS'], source: 'onboarding' })).status).toBe(201)
    expect((await req(ada.jar, 'GET', '/api/users/me')).data.consentRequired).toEqual([])
    // An older version on file: writes wait for the new one.
    await testPrisma.consentRecord.updateMany({ where: { userId: ada.userId, type: 'TERMS' }, data: { version: '2020-01-01' } })
    const refused = await req(ada.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'After the change', body: 'x' })
    expect(refused.status).toBe(403)
    expect(refused.data.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { consents: ['TERMS'] } })
    expect((await req(ada.jar, 'GET', '/api/feed')).status).toBe(200)
    expect((await req(ada.jar, 'POST', '/api/users/me/consents', { type: 'TERMS', version: versions.TERMS })).status).toBe(201)
    expect((await req(ada.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'After accepting', body: 'x' })).status).toBe(201)
  })

  it('deletes an account through the inventory: private data gone, posts blanked, shared work kept, the Clerk account removed', async () => {
    const carol = await registerAndLogin(`pvz${suffix}@test.dev`, `pvz${suffix}`)
    const post = await req(carol.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'My last post', body: 'Goodbye' })
    await req(carol.jar, 'POST', `/api/users/${ada.userId}/follow`)
    await req(carol.jar, 'POST', '/api/mutes', { userId: ben.userId })
    await testPrisma.consentRecord.create({ data: { userId: carol.userId, type: 'TERMS', version: versions.TERMS, source: 'api' } })

    const deleted = await req(carol.jar, 'DELETE', '/api/users/me')
    expect(deleted.status).toBe(200)
    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: carol.userId } })
    expect(row.deletedAt).not.toBeNull()
    expect(row.email).toMatch(/@deleted\.invalid$/)
    expect(row.clerkId).toBeNull()
    expect(await testPrisma.follow.count({ where: { followerId: carol.userId } })).toBe(0)
    expect(await testPrisma.mute.count({ where: { muterId: carol.userId } })).toBe(0)
    expect(await testPrisma.shipPost.findUniqueOrThrow({ where: { id: post.data.post.id } })).toMatchObject({ title: '[deleted]', body: '[deleted]' })
    // The proof of consent is kept.
    expect(await testPrisma.consentRecord.count({ where: { userId: carol.userId } })).toBe(1)
    // The session no longer works.
    expect((await req(carol.jar, 'GET', '/api/users/me')).status).toBe(401)
  })
})
