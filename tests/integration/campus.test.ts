import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { registerAndLogin, req, uniqueSuffix, type TestUser } from './helpers'
import { bornYearsAgo } from './matching-fixtures'
import { CODE_LENGTH, codeHashOf } from '../../src/lib/campus/campus'

// Verifying a campus: an admin makes the campus, a person proves a campus e-mail address with a code, and only then are they on its board and in its feed. The address is never
// kept or shown. The server mails the code from its own memory, which a test cannot read, so the code is found the way an attacker with the database could not: from its keyed hash,
// by trying the million possibilities with the key this run was given.
describe('campus verification', () => {
  const suffix = uniqueSuffix().toLowerCase()
  let n = 0
  let admin: TestUser
  const campuses: string[] = []

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    const name = `cmadmin${suffix}`
    admin = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(admin.userId)
  }, 60_000)
  afterAll(async () => {
    await cleanupTestUsers(suffix)
    await testPrisma.campus.deleteMany({ where: { id: { in: campuses } } })
  }, 120_000)

  /** A signed-in adult. */
  async function adult(): Promise<TestUser> {
    const name = `cm${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    await testPrisma.user.update({ where: { id: u.userId }, data: { birthDate: new Date(`${bornYearsAgo(25, 50)}T00:00:00Z`) } })
    return u
  }
  async function makeCampus(name: string, domains = [`${suffix}.edu`], extra: Record<string, unknown> = {}) {
    const res = await req(admin.jar, 'POST', '/api/admin/campuses', { name, emailDomains: domains, city: 'Pune', countryCode: 'IN', ...extra })
    expect(res.status, JSON.stringify(res.data)).toBe(201)
    campuses.push(res.data.campus.id)
    return res.data.campus as { id: string; slug: string; name: string; emailDomains: string[] }
  }
  const crackCode = async (userId: string): Promise<string> => {
    const row = await testPrisma.campusVerification.findUniqueOrThrow({ where: { userId } })
    for (let i = 0; i < 10 ** CODE_LENGTH; i++) {
      const code = String(i).padStart(CODE_LENGTH, '0')
      if (codeHashOf(userId, code) === row.codeHash) return code
    }
    throw new Error('no code matches the hash')
  }
  const address = (local: string) => `${local}${suffix}@cs.${suffix}.edu`

  describe('managing campuses (admin)', () => {
    it('creates a campus with a slug from its name and tidied domains, and refuses a duplicate or bad input', async () => {
      const made = await makeCampus(`Pune Institute ${suffix}`, [`MAIN.${suffix}.edu`, `main.${suffix}.edu`])
      expect(made).toMatchObject({ slug: `pune-institute-${suffix}`, name: `Pune Institute ${suffix}`, emailDomains: [`main.${suffix}.edu`] })
      const again = await req(admin.jar, 'POST', '/api/admin/campuses', { name: `Pune Institute ${suffix}`, emailDomains: ['x.edu'] })
      expect(again.status).toBe(409)
      expect(again.data.error.code).toBe('CAMPUS_SLUG_TAKEN')
      for (const body of [{ name: 'x', emailDomains: ['a.edu'] }, { name: 'Valid Name', emailDomains: [] }, { name: 'Valid Name', emailDomains: ['not a domain'] }, { name: 'Valid Name', emailDomains: ['a.edu'], countryCode: 'ZZ' }, { name: 'Valid Name', emailDomains: ['a.edu'], extra: 1 }]) {
        const res = await req(admin.jar, 'POST', '/api/admin/campuses', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
    })

    it('renames a campus, changes its domains and closes it, but never changes the slug; lists them for admins only', async () => {
      const made = await makeCampus(`Rename Me ${suffix}`)
      const patched = await req(admin.jar, 'PATCH', `/api/admin/campuses/${made.id}`, { name: `Renamed ${suffix}`, emailDomains: ['new.edu'], disabled: true })
      expect(patched.status).toBe(200)
      expect(patched.data.campus).toMatchObject({ slug: made.slug, name: `Renamed ${suffix}`, emailDomains: ['new.edu'] })
      expect(patched.data.campus.disabledAt).toBeTruthy()
      expect((await req(admin.jar, 'PATCH', `/api/admin/campuses/${made.id}`, { slug: 'other' })).status).toBe(400)
      expect((await req(admin.jar, 'PATCH', '/api/admin/campuses/nope', { name: 'Whatever' })).data.error.code).toBe('CAMPUS_NOT_FOUND')
      const list = await req(admin.jar, 'GET', `/api/admin/campuses?q=${encodeURIComponent(`Renamed ${suffix}`)}`)
      expect(list.data.campuses[0]).toMatchObject({ id: made.id, members: 0 })
      const member = await adult()
      expect((await req(member.jar, 'GET', '/api/admin/campuses')).status).toBe(403)
      expect((await req(member.jar, 'POST', '/api/admin/campuses', { name: 'Nope Nope', emailDomains: ['a.edu'] })).status).toBe(403)
      expect((await req(member.jar, 'PATCH', `/api/admin/campuses/${made.id}`, { name: 'Nope Nope' })).status).toBe(403)
    })

    it('lets people find the campuses that take members, with the domains to use, and hides closed ones', async () => {
      const open = await makeCampus(`Findable Open ${suffix}`)
      const closed = await makeCampus(`Findable Closed ${suffix}`)
      await req(admin.jar, 'PATCH', `/api/admin/campuses/${closed.id}`, { disabled: true })
      const me = await adult()
      const res = await req(me.jar, 'GET', `/api/campuses?q=findable ${suffix}`)
      expect(res.status).toBe(200)
      expect(res.data.campuses.map((c: { id: string }) => c.id)).toEqual([open.id])
      expect(res.data.campuses[0]).toEqual({ id: open.id, slug: open.slug, name: open.name, city: 'Pune', countryCode: 'IN', emailDomains: open.emailDomains })
      expect((await req(null, 'GET', '/api/campuses')).status).toBe(401)
    })
  })

  describe('verifying', () => {
    it('mails a code, confirms it, and puts the person on the campus: its key, its name, and nothing of the address', async () => {
      const campus = await makeCampus(`Verify Uni ${suffix}`)
      const me = await adult()
      const email = address('ada')
      const start = await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email })
      expect(start.status, JSON.stringify(start.data)).toBe(200)
      expect(start.data).toMatchObject({ sent: true, domain: `cs.${suffix}.edu`, expiresInMinutes: 15 })
      expect(JSON.stringify(start.data)).not.toContain(email)

      const pending = await req(me.jar, 'GET', '/api/campus/me')
      expect(pending.data).toMatchObject({ campus: null, pending: { campusId: campus.id, domain: `cs.${suffix}.edu` }, canJoin: true })
      expect(JSON.stringify(pending.data)).not.toContain(email)

      // A wrong code costs a try.
      const wrong = await req(me.jar, 'POST', '/api/campus/verification/confirm', { code: '000000' })
      expect(wrong.status).toBe(400)
      expect(wrong.data.error).toMatchObject({ code: 'CAMPUS_CODE_INVALID', params: { remaining: 4 } })

      const code = await crackCode(me.userId)
      const done = await req(me.jar, 'POST', '/api/campus/verification/confirm', { code })
      expect(done.status).toBe(200)
      expect(done.data).toEqual({ campus: { id: campus.id, slug: campus.slug, name: campus.name } })

      // The address is gone: not in the pending row (deleted), not in the membership (a hash), not in any answer.
      expect(await testPrisma.campusVerification.count({ where: { userId: me.userId } })).toBe(0)
      const membership = await testPrisma.campusMembership.findUniqueOrThrow({ where: { userId: me.userId } })
      expect(JSON.stringify(membership)).not.toContain(email)
      expect(membership.emailHash).toMatch(/^[0-9a-f]{64}$/)
      expect(await testPrisma.profile.findUnique({ where: { userId: me.userId } })).toMatchObject({ campus: campus.name, campusKey: campus.slug, countryCode: 'IN' })

      const mine = await req(me.jar, 'GET', '/api/campus/me')
      expect(mine.data).toMatchObject({ campus: { id: campus.id, slug: campus.slug, name: campus.name, city: 'Pune', countryCode: 'IN' }, pending: null })
      expect(JSON.stringify(mine.data)).not.toContain(email)
      // And the campus board now has a place for them.
      expect((await req(me.jar, 'GET', '/api/leaderboard?scope=campus')).data.myScopes.campus).toBe(campus.slug)
      // Nobody else's view of them says which campus mailbox it was.
      const other = await adult()
      expect(JSON.stringify((await req(other.jar, 'GET', `/api/users/${me.userId}`)).data)).not.toContain(email)
    })

    it('refuses an address on another domain (saying which domains work), a throwaway one, and a campus that is closed', async () => {
      const campus = await makeCampus(`Domain Uni ${suffix}`, [`domain.${suffix}.edu`])
      const closed = await makeCampus(`Closed Uni ${suffix}`)
      await req(admin.jar, 'PATCH', `/api/admin/campuses/${closed.id}`, { disabled: true })
      const me = await adult()
      const wrong = await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: `ada@gmail.com` })
      expect(wrong.status).toBe(400)
      expect(wrong.data.error).toMatchObject({ code: 'CAMPUS_EMAIL_INVALID', params: { domains: `domain.${suffix}.edu` } })
      for (const email of [`ada@evildomain.${suffix}.edu`, `ada@domain.${suffix}.edu.evil.com`, 'not an address']) {
        expect((await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email })).status, email).toBe(400)
      }
      expect(await testPrisma.campusVerification.count({ where: { userId: me.userId } })).toBe(0)
      // (At most five a hour a person, so the next two are asked by somebody else.)
      const other = await adult()
      expect((await req(other.jar, 'POST', '/api/campus/verification', { campusId: closed.id, email: address('x') })).data.error.code).toBe('CAMPUS_CLOSED')
      expect((await req(other.jar, 'POST', '/api/campus/verification', { campusId: 'nope', email: address('x') })).data.error.code).toBe('CAMPUS_NOT_FOUND')
    })

    it('accepts a subdomain of the campus domain', async () => {
      const campus = await makeCampus(`Sub Uni ${suffix}`, [`sub.${suffix}.edu`])
      const me = await adult()
      expect((await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: `grace@lab.sub.${suffix}.edu` })).status).toBe(200)
    })

    it('does not take a minor, or a person who has not said how old they are, onto a campus', async () => {
      const campus = await makeCampus(`Minor Uni ${suffix}`)
      const kid = await adult()
      await testPrisma.user.update({ where: { id: kid.userId }, data: { birthDate: new Date(`${bornYearsAgo(16, 40)}T00:00:00Z`) } })
      const unknown = await adult()
      await testPrisma.user.update({ where: { id: unknown.userId }, data: { birthDate: null } })
      for (const who of [kid, unknown]) {
        const res = await req(who.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: address('kid') })
        expect(res.status).toBe(400)
        expect(res.data.error.code).toBe('MINOR_LOCATION_LIMITED')
        expect((await req(who.jar, 'GET', '/api/campus/me')).data.canJoin).toBe(false)
        expect(await testPrisma.campusVerification.count({ where: { userId: who.userId } })).toBe(0)
      }
    })

    it('lets one campus mailbox verify one account', async () => {
      const campus = await makeCampus(`Mailbox Uni ${suffix}`)
      const first = await adult()
      const second = await adult()
      const email = address('shared')
      expect((await req(first.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email })).status).toBe(200)
      expect((await req(first.jar, 'POST', '/api/campus/verification/confirm', { code: await crackCode(first.userId) })).status).toBe(200)
      const taken = await req(second.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: email.toUpperCase() })
      expect(taken.status).toBe(409)
      expect(taken.data.error.code).toBe('CAMPUS_EMAIL_IN_USE')
      // The first account can ask again for the same mailbox (to move to it again after leaving, say).
      expect((await req(first.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email })).status).toBe(200)
    })

    it('voids a code after five wrong tries, and an expired code', async () => {
      const campus = await makeCampus(`Tries Uni ${suffix}`)
      const me = await adult()
      await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: address('tries') })
      for (let remaining = 4; remaining >= 1; remaining--) {
        const wrong = await req(me.jar, 'POST', '/api/campus/verification/confirm', { code: '111111' })
        expect(wrong.data.error).toMatchObject({ code: 'CAMPUS_CODE_INVALID', params: { remaining } })
      }
      expect((await req(me.jar, 'POST', '/api/campus/verification/confirm', { code: '111111' })).data.error.code).toBe('CAMPUS_CODE_EXPIRED')
      expect((await req(me.jar, 'POST', '/api/campus/verification/confirm', { code: '111111' })).data.error.code).toBe('CAMPUS_VERIFICATION_NOT_FOUND')

      await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: address('tries') })
      const code = await crackCode(me.userId)
      await testPrisma.campusVerification.update({ where: { userId: me.userId }, data: { expiresAt: new Date(Date.now() - 1000) } })
      const late = await req(me.jar, 'POST', '/api/campus/verification/confirm', { code })
      expect(late.status).toBe(410)
      expect(late.data.error.code).toBe('CAMPUS_CODE_EXPIRED')
      expect(await testPrisma.campusMembership.count({ where: { userId: me.userId } })).toBe(0)
    })

    it('needs a six-digit code, and a verification to confirm', async () => {
      const me = await adult()
      for (const code of ['', '12345', '1234567', 'abcdef', '12 345']) expect((await req(me.jar, 'POST', '/api/campus/verification/confirm', { code })).status, code).toBe(400)
      expect((await req(me.jar, 'POST', '/api/campus/verification/confirm', { code: '123456' })).data.error.code).toBe('CAMPUS_VERIFICATION_NOT_FOUND')
      expect((await req(me.jar, 'POST', '/api/campus/verification', { campusId: 'x' })).status).toBe(400)
      expect((await req(null, 'POST', '/api/campus/verification', { campusId: 'x', email: 'a@b.edu' })).status).toBe(401)
    })

    it('limits how many codes a person can ask for in an hour', async () => {
      const campus = await makeCampus(`Limit Uni ${suffix}`)
      const me = await adult()
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) statuses.push((await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: address(`limit${i}`) })).status)
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
      expect(statuses.slice(5)).toEqual([429, 429])
    })
  })

  describe('being on a campus', () => {
    async function member(campus: { id: string }) {
      const me = await adult()
      await req(me.jar, 'POST', '/api/campus/verification', { campusId: campus.id, email: address(`m${n}`) })
      expect((await req(me.jar, 'POST', '/api/campus/verification/confirm', { code: await crackCode(me.userId) })).status).toBe(200)
      return me
    }

    it('keeps the campus text from being changed while verified, and lets the person leave', async () => {
      const campus = await makeCampus(`Leave Uni ${suffix}`)
      const me = await member(campus)
      const blocked = await req(me.jar, 'PATCH', '/api/users/me/profile', { campus: 'Somewhere Else' })
      expect(blocked.status).toBe(409)
      expect(blocked.data.error.code).toBe('CAMPUS_IS_VERIFIED')
      expect((await req(me.jar, 'PATCH', '/api/users/me/profile', { city: 'Pune' })).status).toBe(200)

      const left = await req(me.jar, 'DELETE', '/api/campus/me')
      expect(left.data).toEqual({ success: true, left: true })
      expect(await testPrisma.campusMembership.count({ where: { userId: me.userId } })).toBe(0)
      expect(await testPrisma.profile.findUnique({ where: { userId: me.userId } })).toMatchObject({ campus: null, campusKey: null })
      expect((await req(me.jar, 'DELETE', '/api/campus/me')).data).toEqual({ success: true, left: false })
      expect((await req(me.jar, 'PATCH', '/api/users/me/profile', { campus: 'Somewhere Else' })).status).toBe(200)
      expect(await testPrisma.profile.findUnique({ where: { userId: me.userId } })).toMatchObject({ campus: 'Somewhere Else', campusKey: null })
    })

    it('puts the person in their campus feed, and nobody else', async () => {
      const campus = await makeCampus(`Feed Uni ${suffix}`)
      const here = await member(campus)
      const neighbour = await member(campus)
      const outsider = await adult()
      expect((await req(outsider.jar, 'GET', '/api/feed?tab=campus')).data.posts).toEqual([])
      const post = async (who: TestUser) => (await req(who.jar, 'POST', '/api/posts', { kind: 'DEMO', title: `Campus post ${suffix}${n++}`, body: 'Hello campus' })).data.post.id as string
      const near = await post(neighbour)
      const away = await post(outsider)
      const ids = (await req(here.jar, 'GET', '/api/feed?tab=campus')).data.posts.map((p: { id: string }) => p.id)
      expect(ids).toContain(near)
      expect(ids).not.toContain(away)
    })

    it('does not count free text as a campus in the feed either', async () => {
      const typed = await adult()
      await req(typed.jar, 'PATCH', '/api/users/me/profile', { campus: `Typed Only ${suffix}` })
      expect((await req(typed.jar, 'GET', '/api/feed?tab=campus')).data.posts).toEqual([])
    })
  })
})
