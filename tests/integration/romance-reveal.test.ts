import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, removePeople } from './matching-fixtures'
import { makeRomancePerson } from './romance-fixtures'
import { agreeToReveal, withdrawReveal } from '../../src/lib/romance/reveal'
import { ROMANCE_MODE_LABEL } from '../../src/lib/romance/config'

// Photos are blurred for the other person until both have agreed, and either can take it back at once.
describe('the photo reveal and the photos', () => {
  const suffix = uniqueSuffix()
  const tag = `rv${suffix}`

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await testPrisma.notification.deleteMany({ where: { user: { username: { startsWith: tag.toLowerCase() } } } })
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 180_000)

  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a])

  async function member(label: string, gender: 'WOMAN' | 'MAN', cityKey: string): Promise<TestUser> {
    const u = await registerAndLogin(`${tag}.${label}@test.dev`, `${tag}${label}`)
    await testPrisma.user.update({ where: { id: u.userId }, data: { isEmailVerified: true, isPhoneVerified: true, birthDate: new Date(`${bornYearsAgo(30)}T00:00:00Z`), image: `https://example.com/${label}.png` } })
    await testPrisma.profile.create({ data: { userId: u.userId, countryCode: 'IN', cityKey, city: cityKey } })
    await testPrisma.romanceProfile.create({
      data: { userId: u.userId, promptObsessed: 'Compilers and the people who love them.', promptBuild: 'A tool I would use every day.', promptWeekend: 'Ship something small, then eat well.', ambition: 3, direction: 'founder', rhythm: 'night-owl', obsessions: ['compilers'], gender, interestedIn: [gender === 'WOMAN' ? 'MAN' : 'WOMAN'], ageMin: 18, ageMax: 99, scope: 'CITY' },
    })
    return u
  }

  async function matched(label: string) {
    const city = `${tag}-${label}`
    const a = await member(`${label}a`, 'WOMAN', city)
    const b = await member(`${label}b`, 'MAN', city)
    const [userAId, userBId] = pair(a.userId, b.userId)
    const conversation = await testPrisma.conversation.create({ data: { type: 'DIRECT', members: { create: [{ userId: a.userId }, { userId: b.userId }] } } })
    const match = await testPrisma.match.create({ data: { userAId, userBId, userARole: 'DATING', userBRole: 'DATING', connectionType: 'DATING', conversationId: conversation.id } })
    return { a, b, match }
  }

  /** Attaches a photo straight in the database (the upload flow has its own tests). */
  async function photo(userId: string, n: number, blurHash: string | null = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj') {
    const profile = await testPrisma.romanceProfile.findUniqueOrThrow({ where: { userId } })
    const sha = createHash('sha256').update(`${userId}${n}`).digest('hex')
    const asset = await testPrisma.mediaAsset.create({ data: { ownerId: userId, purpose: 'ROMANCE_PHOTO', kind: 'IMAGE', key: `romance/${userId}/${sha}.jpg`, contentType: 'image/jpeg', bytes: 1000, width: 800, height: 800, sha256: sha, status: 'READY' } })
    return testPrisma.romancePhoto.create({ data: { profileId: profile.id, assetId: asset.id, position: n, blurHash } })
  }
  const seenBy = async (viewer: TestUser, matchId: string) => (await req(viewer.jar, 'GET', `/api/romance/matches/${matchId}`)).data

  describe('the flow', () => {
    it('shows only placeholders until both agree, then the photos and the avatar, and blurs them again at once when either takes it back', async () => {
      const { a, b, match } = await matched('flow')
      const pa = await photo(a.userId, 0)
      await photo(b.userId, 0)
      const secrets = [`romance/${a.userId}`, 'a.png']

      let view = await seenBy(b, match.id)
      expect(view.reveal.status).toBe('NONE')
      expect(view.other.photos).toEqual([{ id: pa.id, position: 0, blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', revealed: false }])
      expect(view.other.image).toBeUndefined()

      // One asks: still blurred for both.
      const asked = await req(a.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})
      expect(asked.status).toBe(200)
      expect(asked.data).toEqual({ matchId: match.id, status: 'PENDING_MINE' })
      view = await seenBy(b, match.id)
      expect(view.reveal.status).toBe('PENDING_THEIRS')
      expect(JSON.stringify(view)).not.toContain(secrets[0])
      expect(JSON.stringify(await seenBy(a, match.id))).not.toContain(`romance/${b.userId}`)
      const notice = await testPrisma.notification.findMany({ where: { userId: b.userId, type: 'SYSTEM' } })
      expect(notice.some((n) => (n.metadata as { kind?: string })?.kind === 'ROMANCE_REVEAL' && n.message.includes('would like to share photos'))).toBe(true)
      // Asking again is the same.
      expect((await req(a.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})).data.status).toBe('PENDING_MINE')

      // The other agrees: both see.
      const accepted = await req(b.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})
      expect(accepted.data.status).toBe('ACCEPTED')
      view = await seenBy(b, match.id)
      expect(view.reveal.status).toBe('ACCEPTED')
      expect(view.other.photos[0]).toMatchObject({ id: pa.id, revealed: true, width: 800, height: 800 })
      expect(typeof view.other.photos[0].url).toBe('string')
      expect(view.other.image).toBe('https://example.com/flowa.png')
      expect((await seenBy(a, match.id)).other.photos[0].revealed).toBe(true)
      // The list shows the same.
      expect((await req(b.jar, 'GET', '/api/romance/matches')).data.matches[0].other.photos[0].revealed).toBe(true)

      // Either revokes: blurred again for both, at once.
      const revoked = await req(a.jar, 'DELETE', `/api/romance/matches/${match.id}/reveal`)
      expect(revoked.data.status).toBe('REVOKED')
      expect((await seenBy(b, match.id)).other.photos[0].revealed).toBe(false)
      expect((await seenBy(a, match.id)).other.photos[0].revealed).toBe(false)
      expect(JSON.stringify(await seenBy(b, match.id))).not.toContain('a.png')
      // And it can be asked for again.
      expect((await req(b.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})).data.status).toBe('PENDING_MINE')
    }, 240_000)

    it('lets the other person decline, and either cancel their own ask', async () => {
      const { a, b, match } = await matched('decl')
      await req(a.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})
      expect((await req(b.jar, 'DELETE', `/api/romance/matches/${match.id}/reveal`)).data.status).toBe('DECLINED')
      expect((await seenBy(a, match.id)).reveal.status).toBe('DECLINED')
      await req(a.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})
      expect((await req(a.jar, 'DELETE', `/api/romance/matches/${match.id}/reveal`)).data.status).toBe('REVOKED')
      // Withdrawing with nothing to withdraw is fine.
      expect((await req(b.jar, 'DELETE', `/api/romance/matches/${match.id}/reveal`)).data.status).toBe('REVOKED')
    }, 180_000)

    it('treats two asks at the same moment as an agreement', async () => {
      const { a, b, match } = await matched('race')
      const results = await Promise.all([agreeToReveal(testPrisma, a.userId, match.id), agreeToReveal(testPrisma, b.userId, match.id)])
      expect(results.every((r) => r.kind === 'OK')).toBe(true)
      expect((await testPrisma.revealRequest.findUniqueOrThrow({ where: { matchId: match.id } })).status).toBe('ACCEPTED')
      expect(await testPrisma.revealRequest.count({ where: { matchId: match.id } })).toBe(1)
    }, 180_000)

    it('is revoked when the match ends, and cannot be asked for on an ended or somebody else\'s match', async () => {
      const { a, b, match } = await matched('end')
      const outsider = await member('endc', 'WOMAN', `${tag}-end`)
      await agreeToReveal(testPrisma, a.userId, match.id)
      await agreeToReveal(testPrisma, b.userId, match.id)
      expect((await req(outsider.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})).status).toBe(404)
      expect((await req(outsider.jar, 'DELETE', `/api/romance/matches/${match.id}/reveal`)).status).toBe(404)
      expect((await req(a.jar, 'DELETE', `/api/matches/${match.id}`)).status).toBe(200)
      expect((await testPrisma.revealRequest.findUniqueOrThrow({ where: { matchId: match.id } })).status).toBe('REVOKED')
      expect((await req(b.jar, 'POST', `/api/romance/matches/${match.id}/reveal`, {})).status).toBe(404)
      expect(await withdrawReveal(testPrisma, b.userId, match.id)).toEqual({ kind: 'NOT_FOUND' })
      expect((await req(null, 'POST', `/api/romance/matches/${match.id}/reveal`, {})).status).toBe(401)
    }, 180_000)

    it('does not work for a professional match', async () => {
      const a = await makeRomancePerson({ tag })
      const b = await makeRomancePerson({ tag })
      const [userAId, userBId] = pair(a.id, b.id)
      const match = await testPrisma.match.create({ data: { userAId, userBId, userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COFOUNDER' } })
      expect(await agreeToReveal(testPrisma, a.id, match.id)).toEqual({ kind: 'NOT_FOUND' })
    }, 60_000)
  })

  describe('POST and DELETE /api/romance/photos', () => {
    const file = () => {
      const bytes = randomBytes(2048)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    async function upload(user: TestUser, purpose = 'ROMANCE_PHOTO') {
      const f = file()
      const declared = await req(user.jar, 'POST', '/api/media/uploads', { purpose, contentType: 'image/jpeg', bytes: f.bytes.length, width: 800, height: 800, sha256: f.sha256 })
      expect(declared.status).toBe(201)
      const put = await fetch(declared.data.upload.url, { method: 'PUT', headers: { Authorization: `Bearer ${await user.jar.token()}`, 'Content-Type': 'image/jpeg', 'x-forwarded-for': user.jar.ip }, body: new Uint8Array(f.bytes) })
      expect(put.status).toBe(200)
      expect((await req(user.jar, 'POST', `/api/media/${declared.data.asset.id}/complete`, {})).data.status).toBe('READY')
      return declared.data.asset.id as string
    }

    it('attaches a confirmed upload, shows it to its owner, removes it, and limits them to six', async () => {
      expect((await req(null, 'POST', '/api/romance/photos', {})).status).toBe(401)
      const u = await member('ph', 'WOMAN', `${tag}-ph`)
      const first = await upload(u)
      const added = await req(u.jar, 'POST', '/api/romance/photos', { assetId: first, blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })
      expect(added.status).toBe(201)
      expect(added.data.position).toBe(0)
      const own = await req(u.jar, 'GET', '/api/romance/profile')
      expect(own.data.photos).toHaveLength(1)
      expect(own.data.photos[0]).toMatchObject({ id: added.data.id, position: 0, blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', width: 800 })
      expect(typeof own.data.photos[0].url).toBe('string')

      // The same upload twice, someone else's, the wrong purpose and a bad hash are all refused.
      expect((await req(u.jar, 'POST', '/api/romance/photos', { assetId: first })).data.error.code).toBe('VALIDATION_FAILED')
      const other = await member('ph2', 'MAN', `${tag}-ph`)
      expect((await req(other.jar, 'POST', '/api/romance/photos', { assetId: first })).data.error.code).toBe('MEDIA_NOT_FOUND')
      const postMedia = await upload(u, 'POST_MEDIA')
      expect((await req(u.jar, 'POST', '/api/romance/photos', { assetId: postMedia })).data.error.code).toBe('MEDIA_NOT_FOUND')
      expect((await req(u.jar, 'POST', '/api/romance/photos', { assetId: first, blurHash: '!!' })).status).toBe(400)
      expect((await req(u.jar, 'POST', '/api/romance/photos', { assetId: first, extra: 1 })).status).toBe(400)

      for (let i = 1; i < 6; i++) expect((await req(u.jar, 'POST', '/api/romance/photos', { assetId: await upload(u) })).status).toBe(201)
      const seventh = await req(u.jar, 'POST', '/api/romance/photos', { assetId: await upload(u) })
      expect(seventh.status).toBe(400)
      expect(seventh.data.error.code).toBe('ROMANCE_PHOTO_LIMIT')

      // Removing closes the gap and deletes the upload; somebody else's is not found.
      expect((await req(other.jar, 'DELETE', `/api/romance/photos/${added.data.id}`)).status).toBe(404)
      expect((await req(u.jar, 'DELETE', `/api/romance/photos/${added.data.id}`)).data).toEqual({ removed: true })
      const after = await req(u.jar, 'GET', '/api/romance/profile')
      expect(after.data.photos.map((p: { position: number }) => p.position)).toEqual([0, 1, 2, 3, 4])
      expect(await testPrisma.mediaAsset.findUnique({ where: { id: first } })).toBeNull()
    }, 300_000)

    it('needs a profile to attach to', async () => {
      const u = await registerAndLogin(`${tag}.nop@test.dev`, `${tag}nop`)
      const res = await req(u.jar, 'POST', '/api/romance/photos', { assetId: 'x' })
      expect(res.status).toBe(400)
      expect(res.data.error.code).toBe('ROMANCE_PROFILE_REQUIRED')
      expect(res.data.error.message).toBe(`Join ${ROMANCE_MODE_LABEL} first`)
    }, 60_000)
  })
})
