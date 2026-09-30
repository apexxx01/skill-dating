import { describe, it, expect, afterAll } from 'vitest'
import { Webhook } from 'svix'
import { INTEGRATION_BASE_URL } from './config'
import { cookieJar, req, registerAndLogin, syntheticIp, uniqueSuffix } from './helpers'
import { createClerkUser, createSession, deleteClerkUser, mintToken, updateClerkUser } from './clerk-api'
import { cleanupTestUsers, testPrisma } from './db'

// The Clerk-backed authentication path, against real Clerk users and real
// session tokens: no application-side bypass exists, so what passes here passes
// for a browser too.
describe('clerk authentication', () => {
  const suffix = uniqueSuffix()
  const marker = `clauth${suffix}`
  const email = (label: string) => `${marker}.${label}@test.dev`
  const name = (label: string) => `${label}${suffix}`

  // Tombstoned rows no longer carry the marker in their email.
  const tombstonedIds: string[] = []

  afterAll(async () => {
    await testPrisma.user.deleteMany({ where: { id: { in: tombstonedIds } } })
    await cleanupTestUsers(marker)
  })

  async function localByEmail(e: string) {
    return testPrisma.user.findMany({ where: { email: e } })
  }

  async function postWebhook(
    event: object,
    opts: { secret?: string; tamper?: boolean; timestamp?: Date; skipHeaders?: boolean } = {}
  ) {
    const body = JSON.stringify(event)
    const secret = opts.secret ?? process.env.TEST_CLERK_WEBHOOK_SECRET!
    const id = `msg_${uniqueSuffix()}`
    const ts = opts.timestamp ?? new Date()
    const signature = new Webhook(secret).sign(id, ts, body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': syntheticIp() }
    if (!opts.skipHeaders) {
      headers['svix-id'] = id
      headers['svix-timestamp'] = String(Math.floor(ts.getTime() / 1000))
      headers['svix-signature'] = signature
    }
    const res = await fetch(INTEGRATION_BASE_URL + '/api/webhooks/clerk', {
      method: 'POST',
      headers,
      body: opts.tamper ? body.replace('user', 'usEr') : body,
    })
    return { status: res.status, data: await res.json().catch(() => null) }
  }

  describe('session tokens', () => {
    it('signs a real user in, creates exactly one local user and records it', async () => {
      const A = await registerAndLogin(email('one'), name('one'))
      const again = await req(A.jar, 'GET', '/api/users/me')
      expect(again.status).toBe(200)
      expect(again.data.id).toBe(A.userId)

      const rows = await localByEmail(email('one'))
      expect(rows).toHaveLength(1)
      expect(rows[0].clerkId).toMatch(/^user_/)
      expect(rows[0].isEmailVerified).toBe(true)
      expect(rows[0].verificationLevel).toBe('EMAIL')
      expect(rows[0].username).toBe(name('one'))
      const created = await testPrisma.auditEvent.count({ where: { userId: A.userId, action: 'USER_CREATED' } })
      expect(created).toBe(1)
    })

    it('rejects requests with no token, a garbage token and a tampered token', async () => {
      expect((await req(null, 'GET', '/api/users/me')).status).toBe(401)
      expect((await req(null, 'GET', '/api/users/me', undefined, { Authorization: 'Bearer not-a-jwt' })).status).toBe(401)

      const A = await registerAndLogin(email('tamper'), name('tamper'))
      const token = (await A.jar.token())!
      const [h, p, s] = token.split('.')
      const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA')
      const bad = await req(null, 'GET', '/api/users/me', undefined, { Authorization: `Bearer ${h}.${p}.${flipped}` })
      expect(bad.status).toBe(401)
      // The payload swapped for another user's claims must not verify either.
      const other = Buffer.from(JSON.stringify({ sub: 'user_someoneelse', exp: 9999999999 })).toString('base64url')
      const forged = await req(null, 'GET', '/api/users/me', undefined, { Authorization: `Bearer ${h}.${other}.${s}` })
      expect(forged.status).toBe(401)
    })

    it('accepts the token from the __session cookie a browser sends', async () => {
      const A = await registerAndLogin(email('cookie'), name('cookie'))
      const res = await fetch(INTEGRATION_BASE_URL + '/api/users/me', {
        headers: { cookie: `theme=dark; __session=${await A.jar.token()}`, 'x-forwarded-for': syntheticIp() },
      })
      expect(res.status).toBe(200)
      expect((await res.json()).id).toBe(A.userId)
    })

    it('stops accepting a token once it has expired', async () => {
      const A = await registerAndLogin(email('expiry'), name('expiry'))
      const token = (await A.jar.token())!
      const fresh = await req(null, 'GET', '/api/users/me', undefined, { Authorization: `Bearer ${token}` })
      expect(fresh.status).toBe(200)
      // Clerk session tokens last 60 seconds; the SDK allows a few seconds of clock skew.
      await new Promise((r) => setTimeout(r, 70_000))
      const stale = await req(null, 'GET', '/api/users/me', undefined, { Authorization: `Bearer ${token}` })
      expect(stale.status).toBe(401)
      // A freshly minted token for the same session still works.
      expect((await req(A.jar, 'GET', '/api/users/me')).status).toBe(200)
    }, 100_000)

    it('is not fooled by the middleware-skipping header (CVE-2025-29927)', async () => {
      const headers = { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' }
      expect((await req(null, 'GET', '/api/users/me', undefined, headers)).status).toBe(401)
      expect((await req(null, 'GET', '/api/notifications', undefined, headers)).status).toBe(401)
      expect((await req(null, 'POST', '/api/projects', { name: 'x' }, headers)).status).toBe(401)

      // A protected PAGE with middleware skipped: the server component checks the session itself.
      const page = await fetch(INTEGRATION_BASE_URL + '/dashboard', { redirect: 'manual', headers: { ...headers, 'x-forwarded-for': syntheticIp() } })
      expect([302, 303, 307, 308]).toContain(page.status)
      expect(page.headers.get('location') ?? '').toContain('/signin')
    }, 60_000)

    it('serves the session shape the frozen UI polls, with the local id', async () => {
      const A = await registerAndLogin(email('compat'), name('compat'))
      const signedIn = await req(A.jar, 'GET', '/api/auth/session')
      expect(signedIn.status).toBe(200)
      expect(signedIn.data.user.id).toBe(A.userId)
      expect(signedIn.data.user.email).toBe(email('compat'))
      expect(typeof signedIn.data.expires).toBe('string')
      expect(JSON.stringify(signedIn.data)).not.toContain('user_')

      const anonymous = await req(null, 'GET', '/api/auth/session')
      expect(anonymous.status).toBe(200)
      expect(anonymous.data).toBeNull()
    })
  })

  describe('first sight of a Clerk account', () => {
    it('creates one row when several first requests arrive at the same moment', async () => {
      const clerkUser = await createClerkUser(email('race'), name('race'))
      const sessionId = await createSession(clerkUser.clerkId)
      const jar = cookieJar(syntheticIp(), () => mintToken(sessionId))
      await jar.refresh()

      const results = await Promise.all(Array.from({ length: 8 }, () => req(jar, 'GET', '/api/users/me')))
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200))
      expect(new Set(results.map((r) => r.data.id)).size).toBe(1)
      expect(await localByEmail(email('race'))).toHaveLength(1)
      expect(await testPrisma.auditEvent.count({ where: { userId: results[0].data.id, action: 'USER_CREATED' } })).toBe(1)
    })

    it('links a legacy account to the Clerk user that proves the same email, keeping its data', async () => {
      const legacy = await testPrisma.user.create({
        data: { email: email('legacy'), username: name('legacyold'), name: 'Legacy Person', xp: 250, passwordHash: 'x' },
      })
      const clerkUser = await createClerkUser(email('legacy'), name('legacynew'))
      const sessionId = await createSession(clerkUser.clerkId)
      const jar = cookieJar(syntheticIp(), () => mintToken(sessionId))

      const me = await req(jar, 'GET', '/api/users/me')
      expect(me.status).toBe(200)
      expect(me.data.id).toBe(legacy.id)

      const rows = await localByEmail(email('legacy'))
      expect(rows).toHaveLength(1)
      expect(rows[0].clerkId).toBe(clerkUser.clerkId)
      expect(rows[0].xp).toBe(250)
      expect(rows[0].name).toBe('Legacy Person')
      expect(rows[0].isEmailVerified).toBe(true)
      expect(await testPrisma.auditEvent.count({ where: { userId: legacy.id, action: 'USER_LINKED' } })).toBe(1)
    })

    it('refuses to take over an email that belongs to an account bound to a different Clerk user', async () => {
      const existing = await testPrisma.user.create({
        data: { email: email('held'), username: name('heldold'), clerkId: `user_bound${suffix}` },
      })
      const clerkUser = await createClerkUser(email('held'), name('heldnew'))
      const sessionId = await createSession(clerkUser.clerkId)
      const jar = cookieJar(syntheticIp(), () => mintToken(sessionId))

      const me = await req(jar, 'GET', '/api/users/me')
      expect(me.status).toBe(409)

      const rows = await localByEmail(email('held'))
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(existing.id)
      expect(rows[0].clerkId).toBe(`user_bound${suffix}`)
      expect(await testPrisma.auditEvent.count({ where: { action: 'ACCOUNT_LINK_CONFLICT', targetId: clerkUser.clerkId } })).toBeGreaterThanOrEqual(1)
    })

    it('never fails a sign-in over a taken username: it adds a suffix from the Clerk id', async () => {
      await testPrisma.user.create({ data: { email: email('namea'), username: name('samename') } })
      const clerkUser = await createClerkUser(email('nameb'), name('samename'))
      const sessionId = await createSession(clerkUser.clerkId)
      const jar = cookieJar(syntheticIp(), () => mintToken(sessionId))

      const me = await req(jar, 'GET', '/api/users/me')
      expect(me.status).toBe(200)
      const body = clerkUser.clerkId.replace(/^user_/, '').toLowerCase()
      expect(me.data.username).toBe(`${name('samename')}_${body.slice(0, 6)}`)
      expect(me.data.username.length).toBeLessThanOrEqual(30)
    })
  })

  describe('webhook', () => {
    it('rejects a missing, wrong, tampered or stale signature and processes nothing', async () => {
      const event = { type: 'user.deleted', data: { id: 'user_doesnotmatter' } }
      expect((await postWebhook(event, { skipHeaders: true })).status).toBe(400)
      expect((await postWebhook(event, { secret: `whsec_${Buffer.from('a-different-secret-entirely-000000').toString('base64')}` })).status).toBe(400)
      expect((await postWebhook(event, { tamper: true })).status).toBe(400)
      expect((await postWebhook(event, { timestamp: new Date(Date.now() - 10 * 60_000) })).status).toBe(400)
      expect((await postWebhook(event, { timestamp: new Date(Date.now() + 10 * 60_000) })).status).toBe(400)
    })

    it('acknowledges a correctly signed event it does not handle', async () => {
      const res = await postWebhook({ type: 'session.created', data: { id: 'sess_1' } })
      expect(res.status).toBe(200)
      expect(res.data.status).toBe('ignored')
    })

    it('user.created syncs the account, and a replay changes nothing', async () => {
      const clerkUser = await createClerkUser(email('hookc'), name('hookc'))
      const event = { type: 'user.created', data: { id: clerkUser.clerkId } }
      const first = await postWebhook(event)
      expect(first.status).toBe(200)
      expect(first.data.status).toBe('synced')
      const replay = await postWebhook(event)
      expect(replay.status).toBe(200)

      const rows = await localByEmail(email('hookc'))
      expect(rows).toHaveLength(1)
      expect(rows[0].clerkId).toBe(clerkUser.clerkId)
      expect(await testPrisma.auditEvent.count({ where: { userId: rows[0].id, action: 'USER_CREATED' } })).toBe(1)
    })

    it('user.updated applies the CURRENT Clerk state, not the payload, so a stale event cannot roll it back', async () => {
      const clerkUser = await createClerkUser(email('hooku'), name('hooku'))
      await postWebhook({ type: 'user.created', data: { id: clerkUser.clerkId } })
      await updateClerkUser(clerkUser.clerkId, { username: name('hookrenamed') })

      // The payload still says the OLD username; the handler must ignore that and re-read Clerk.
      const stale = { type: 'user.updated', data: { id: clerkUser.clerkId, username: name('hooku') } }
      expect((await postWebhook(stale)).status).toBe(200)
      let row = (await localByEmail(email('hooku')))[0]
      expect(row.username).toBe(name('hookrenamed'))

      // Replaying the stale event again is harmless.
      expect((await postWebhook(stale)).status).toBe(200)
      row = (await localByEmail(email('hooku')))[0]
      expect(row.username).toBe(name('hookrenamed'))
    })

    it('user.deleted anonymises and detaches the row but keeps the content, and a replay is harmless', async () => {
      const A = await registerAndLogin(email('gone'), name('gone'))
      const project = await req(A.jar, 'POST', '/api/projects', { name: `Gone Project ${suffix}` })
      expect(project.status).toBe(201)
      tombstonedIds.push(A.userId)
      const before = (await localByEmail(email('gone')))[0]
      const staleToken = (await A.jar.token())!

      await deleteClerkUser(before.clerkId!)
      const res = await postWebhook({ type: 'user.deleted', data: { id: before.clerkId, deleted: true } })
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ status: 'tombstoned', found: true })

      const after = await testPrisma.user.findUniqueOrThrow({ where: { id: A.userId } })
      expect(after.deletedAt).not.toBeNull()
      expect(after.clerkId).toBeNull()
      expect(after.email).toMatch(/@deleted\.invalid$/)
      expect(after.username).toMatch(/^deleted_/)
      expect(after.name).toBeNull()
      expect(after.passwordHash).toBeNull()
      // The project the person owned still exists, attributed to the anonymised profile.
      const kept = await testPrisma.project.findUnique({ where: { id: project.data.id } })
      expect(kept?.ownerId).toBe(A.userId)

      // The token was minted before deletion and is still inside its 60 seconds: Clerk no longer knows the account.
      const late = await req(null, 'GET', '/api/users/me', undefined, { Authorization: `Bearer ${staleToken}` })
      expect(late.status).toBe(401)

      const replay = await postWebhook({ type: 'user.deleted', data: { id: before.clerkId, deleted: true } })
      expect(replay.status).toBe(200)
      expect(replay.data).toEqual({ status: 'tombstoned', found: false })

      // Signing up again with the same address is a fresh account, not a resurrection.
      const again = await registerAndLogin(email('gone'), name('gonetwo'))
      expect(again.userId).not.toBe(A.userId)

      // The anonymised row is left out of browse and search for everyone else.
      const users = await req(again.jar, 'GET', '/api/users?search=deleted_&limit=50')
      expect(users.status).toBe(200)
      expect(users.data.users.map((u: { id: string }) => u.id)).not.toContain(A.userId)
      const discover = await req(again.jar, 'GET', '/api/discover?search=deleted_&limit=50')
      expect(discover.status).toBe(200)
      expect(JSON.stringify(discover.data)).not.toContain(A.userId)
    })
  })
})
