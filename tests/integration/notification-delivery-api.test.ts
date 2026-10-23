import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { Webhook } from 'svix'
import { INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers, testPrisma } from './db'
import { registerAndLogin, req, syntheticIp, uniqueSuffix, type TestUser } from './helpers'
import { openToken, unsubscribeToken } from '../../src/lib/notify/tokens'
import { suppressionKey } from '../../src/lib/notify/settings'

// The notification delivery routes over HTTP: settings, push devices, the signed links in emails, and the email provider's webhook.
describe('notification delivery routes', () => {
  const suffix = uniqueSuffix()
  let n = 0
  // The suppression list holds hashes, so the addresses used here are remembered to be cleaned up.
  const suppressedAddresses: string[] = []
  // The links in these tests are signed here with the same key the server verifies them with (set by the harness).
  beforeAll(() => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  const user = async (label: string): Promise<TestUser> => {
    const name = `ndr${label}${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  afterAll(async () => {
    await testPrisma.emailSuppression.deleteMany({ where: { emailHash: { in: suppressedAddresses.map(suppressionKey) } } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
  const device = (id: string) => ({ endpoint: `https://push.example.test/${suffix}/${id}`, keys, label: 'Chrome on macOS' })

  describe('GET /api/notifications/channels and PUT', () => {
    it('shows the defaults: everything on that the policy turns on, quiet hours 22:00 to 08:00, digests on, with no consent needed', async () => {
      const a = await user('def')
      const res = await req(a.jar, 'GET', '/api/notifications/channels')
      expect(res.status).toBe(200)
      expect(res.data.settings).toEqual({ emailEnabled: true, pushEnabled: true, quietHours: { enabled: true, start: '22:00', end: '08:00' }, dailyDigest: true, weeklyDigest: true })
      expect(res.data.marketingConsent).toBe(false)
      expect(res.data.push).toEqual({ devices: 0, configured: false })
      expect(res.data.email).toEqual({ verified: expect.any(Boolean), undeliverable: false })
      const byKind = Object.fromEntries(res.data.kinds.map((k: any) => [k.kind, k]))
      expect(byKind.SQUAD_INVITE.email).toEqual({ enabled: true, default: true, available: true })
      expect(byKind.PROPS.email.enabled).toBe(false)
      expect(byKind.DIGEST_DAILY.push.available).toBe(false)
      expect(byKind.DIGEST_DAILY.class).toBe('ACTIVITY')
      // Account notices are not a choice.
      expect(byKind.MODERATION).toBeUndefined()
      expect(byKind.DATA_EXPORT).toBeUndefined()
    })

    it('saves global switches, quiet hours and per-kind choices, and returns the whole picture', async () => {
      const a = await user('put')
      const res = await req(a.jar, 'PUT', '/api/notifications/channels', {
        settings: { emailEnabled: false, quietHours: { start: '23:30', end: '07:15' }, weeklyDigest: false },
        kinds: { COMMENT: { email: true, push: false }, SQUAD_INVITE: { email: false } },
      })
      expect(res.status).toBe(200)
      expect(res.data.settings).toMatchObject({ emailEnabled: false, quietHours: { enabled: true, start: '23:30', end: '07:15' }, weeklyDigest: false, dailyDigest: true })
      const byKind = Object.fromEntries(res.data.kinds.map((k: any) => [k.kind, k]))
      expect(byKind.COMMENT.email.enabled).toBe(true)
      expect(byKind.COMMENT.push.enabled).toBe(false)
      expect(byKind.SQUAD_INVITE.email.enabled).toBe(false)
      expect(byKind.SQUAD_INVITE.push.enabled).toBe(true)
      expect((await req(a.jar, 'GET', '/api/notifications/channels')).data.settings.quietHours.start).toBe('23:30')
    })

    it('refuses unknown fields and kinds, bad times, an empty body, an account notice, and a channel a kind does not use', async () => {
      const a = await user('bad')
      for (const body of [
        {},
        { settings: {} , extra: 1 },
        { settings: { quietHours: { start: '25:00' } } },
        { settings: { quietHours: { start: '8:00' } } },
        { kinds: { NOT_A_KIND: { email: true } } },
        { kinds: { MODERATION: { email: false } } },
        { kinds: { COMMENT: { sms: true } } },
        { kinds: { DIGEST_DAILY: { push: true } } },
      ]) {
        const res = await req(a.jar, 'PUT', '/api/notifications/channels', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    })

    it('needs a signed-in caller', async () => {
      expect((await req(null, 'GET', '/api/notifications/channels')).status).toBe(401)
      expect((await req(null, 'PUT', '/api/notifications/channels', { settings: { emailEnabled: false } })).status).toBe(401)
    })
  })

  describe('push devices', () => {
    it('registers a browser, lists it, refreshes it without duplicating, and unsubscribes it by endpoint or by id', async () => {
      const a = await user('push')
      const first = await req(a.jar, 'POST', '/api/notifications/push', device('one'))
      expect(first.status).toBe(201)
      expect(first.data.device).toMatchObject({ label: 'Chrome on macOS' })
      expect(JSON.stringify(first.data)).not.toContain(keys.auth)
      expect((await req(a.jar, 'POST', '/api/notifications/push', device('one'))).status).toBe(200)

      const list = await req(a.jar, 'GET', '/api/notifications/push')
      expect(list.status).toBe(200)
      expect(list.data.devices).toHaveLength(1)
      expect(typeof list.data.publicKey).toBe('string')
      expect(list.data.publicKey.length).toBeGreaterThan(40)
      expect(list.data.maxDevices).toBe(10)
      expect(JSON.stringify(list.data)).not.toContain('push.example.test')

      await req(a.jar, 'POST', '/api/notifications/push', device('two'))
      expect((await req(a.jar, 'DELETE', '/api/notifications/push', { endpoint: device('one').endpoint })).status).toBe(200)
      expect((await req(a.jar, 'DELETE', '/api/notifications/push', { endpoint: device('one').endpoint })).data.error.code).toBe('PUSH_DEVICE_NOT_FOUND')
      const remaining = (await req(a.jar, 'GET', '/api/notifications/push')).data.devices
      expect(remaining).toHaveLength(1)
      expect((await req(a.jar, 'DELETE', `/api/notifications/push/${remaining[0].id}`)).status).toBe(200)
      expect((await req(a.jar, 'DELETE', `/api/notifications/push/${remaining[0].id}`)).data.error.code).toBe('PUSH_DEVICE_NOT_FOUND')
    })

    it('moves a browser to the account that signs in on it, and does not let one account remove another’s device', async () => {
      const a = await user('mv1')
      const b = await user('mv2')
      await req(a.jar, 'POST', '/api/notifications/push', device('shared'))
      const mine = (await req(a.jar, 'GET', '/api/notifications/push')).data.devices[0]
      expect((await req(b.jar, 'DELETE', `/api/notifications/push/${mine.id}`)).status).toBe(404)
      expect((await req(b.jar, 'DELETE', '/api/notifications/push', { endpoint: device('shared').endpoint })).status).toBe(404)
      expect((await req(b.jar, 'POST', '/api/notifications/push', device('shared'))).status).toBe(200)
      expect((await req(a.jar, 'GET', '/api/notifications/push')).data.devices).toHaveLength(0)
      expect((await req(b.jar, 'GET', '/api/notifications/push')).data.devices).toHaveLength(1)
    })

    it('caps the devices of an account at ten', async () => {
      const a = await user('cap')
      for (let i = 0; i < 10; i++) expect((await req(a.jar, 'POST', '/api/notifications/push', device(`cap${i}`))).status).toBe(201)
      const over = await req(a.jar, 'POST', '/api/notifications/push', device('cap-over'))
      expect(over.status).toBe(409)
      expect(over.data.error).toMatchObject({ code: 'PUSH_DEVICE_LIMIT', params: { max: 10 } })
      // Refreshing one it already has is not "one more".
      expect((await req(a.jar, 'POST', '/api/notifications/push', device('cap0'))).status).toBe(200)
    })

    it('refuses an endpoint the server should not be asked to call, and malformed keys', async () => {
      const a = await user('ep')
      for (const endpoint of ['http://push.example.test/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://u:p@push.example.test/x']) {
        const res = await req(a.jar, 'POST', '/api/notifications/push', { endpoint, keys })
        expect(res.data.error.code, endpoint).toBe('PUSH_ENDPOINT_NOT_ALLOWED')
      }
      expect((await req(a.jar, 'POST', '/api/notifications/push', { endpoint: device('k').endpoint, keys: { p256dh: 'not base64!!', auth: keys.auth } })).data.error.code).toBe('VALIDATION_FAILED')
      expect((await req(a.jar, 'POST', '/api/notifications/push', { ...device('k'), extra: true })).data.error.code).toBe('VALIDATION_FAILED')
    })

    it('needs a signed-in caller', async () => {
      expect((await req(null, 'GET', '/api/notifications/push')).status).toBe(401)
      expect((await req(null, 'POST', '/api/notifications/push', device('anon'))).status).toBe(401)
    })
  })

  describe('the unsubscribe link', () => {
    const call = (method: 'GET' | 'POST', token: string, extra: RequestInit = {}) =>
      fetch(`${INTEGRATION_BASE_URL}/api/notifications/unsubscribe?t=${encodeURIComponent(token)}`, { method, headers: { 'x-forwarded-for': syntheticIp() }, ...extra })

    it('switches the kind off by email from the link in the email body, with a plain page, and leaves the rest alone', async () => {
      const a = await user('un1')
      const res = await call('GET', unsubscribeToken({ userId: a.userId, kind: 'SQUAD_INVITE' }))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('<h1>You are unsubscribed</h1>')
      expect(html).toContain('Invitations to join a squad')
      const view = (await req(a.jar, 'GET', '/api/notifications/channels')).data
      const byKind = Object.fromEntries(view.kinds.map((k: any) => [k.kind, k]))
      expect(byKind.SQUAD_INVITE.email.enabled).toBe(false)
      expect(byKind.SQUAD_INVITE.push.enabled).toBe(true)
      expect(byKind.MATCH.email.enabled).toBe(true)
      expect(view.settings.emailEnabled).toBe(true)
    })

    it('switches every optional email off, digests included, on one click from a mail client (RFC 8058)', async () => {
      const a = await user('un2')
      const res = await call('POST', unsubscribeToken({ userId: a.userId, kind: 'ALL' }), { headers: { 'x-forwarded-for': syntheticIp(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, applied: true, kind: 'ALL' })
      const settings = (await req(a.jar, 'GET', '/api/notifications/channels')).data.settings
      expect(settings).toMatchObject({ emailEnabled: false, dailyDigest: false, weeklyDigest: false, pushEnabled: true })
    })

    it('can be repeated, and cannot switch off an account notice', async () => {
      const a = await user('un3')
      const token = unsubscribeToken({ userId: a.userId, kind: 'COMMENT' })
      expect((await call('POST', token)).status).toBe(200)
      expect((await call('POST', token)).status).toBe(200)
      expect(await testPrisma.channelPreference.count({ where: { userId: a.userId, kind: 'COMMENT', channel: 'EMAIL' } })).toBe(1)
      const security = await call('POST', unsubscribeToken({ userId: a.userId, kind: 'MODERATION' }))
      expect(await security.json()).toMatchObject({ applied: false })
      expect(await testPrisma.channelPreference.count({ where: { userId: a.userId, kind: 'MODERATION' } })).toBe(0)
    })

    it('refuses a link that was changed, forged or cut short, without changing anything', async () => {
      const a = await user('un4')
      const good = unsubscribeToken({ userId: a.userId, kind: 'ALL' })
      const [body, signature] = good.split('.')
      for (const token of ['', 'abc', `${body}.${signature.slice(0, -3)}abc`, `${Buffer.from(JSON.stringify({ u: 'someone-else', k: 'ALL' })).toString('base64url')}.${signature}`, good.slice(0, -5)]) {
        const get = await call('GET', token)
        expect(get.status, token).toBe(400)
        expect(await get.text()).toContain('This link does not work')
        const post = await call('POST', token)
        expect(post.status, token).toBe(400)
        expect((await post.json()).error.code).toBe('UNSUBSCRIBE_LINK_INVALID')
      }
      expect((await req(a.jar, 'GET', '/api/notifications/channels')).data.settings.emailEnabled).toBe(true)
    })

    it('answers an open page with no sign-in at all, and states that it does not cache', async () => {
      const a = await user('un5')
      const res = await call('GET', unsubscribeToken({ userId: a.userId, kind: 'COMMENT' }))
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    })
  })

  describe('the click-through link', () => {
    it('records the open and sends the person on to the signed destination, inside the app', async () => {
      const a = await user('op1')
      const delivery = await testPrisma.notificationDelivery.create({ data: { userId: a.userId, kind: 'SQUAD_INVITE', channel: 'EMAIL', status: 'SENT', dedupeKey: `open:${suffix}:1`, sentAt: new Date() } })
      const res = await fetch(`${INTEGRATION_BASE_URL}/api/notifications/open/${openToken(delivery.id, '/teams/t1')}`, { redirect: 'manual', headers: { 'x-forwarded-for': syntheticIp() } })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`${INTEGRATION_BASE_URL}/teams/t1`)
      const first = (await testPrisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).openedAt
      expect(first).not.toBeNull()
      await fetch(`${INTEGRATION_BASE_URL}/api/notifications/open/${openToken(delivery.id, '/teams/t1')}`, { redirect: 'manual', headers: { 'x-forwarded-for': syntheticIp() } })
      expect((await testPrisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).openedAt).toEqual(first)
    })

    it('never redirects anywhere but the app, whatever the token says', async () => {
      for (const token of ['junk', openToken('x', 'https://evil.example.com/'), openToken('x', '//evil.example.com')]) {
        const res = await fetch(`${INTEGRATION_BASE_URL}/api/notifications/open/${encodeURIComponent(token)}`, { redirect: 'manual', headers: { 'x-forwarded-for': syntheticIp() } })
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe(`${INTEGRATION_BASE_URL}/`)
      }
    })
  })

  describe('POST /api/notifications/deliveries/{id}/open', () => {
    it('lets the person the push was for report the tap, once', async () => {
      const a = await user('dl1')
      const b = await user('dl2')
      const delivery = await testPrisma.notificationDelivery.create({ data: { userId: a.userId, kind: 'COMMENT', channel: 'PUSH', status: 'SENT', dedupeKey: `tap:${suffix}`, sentAt: new Date() } })
      expect((await req(b.jar, 'POST', `/api/notifications/deliveries/${delivery.id}/open`)).data.error.code).toBe('DELIVERY_NOT_FOUND')
      expect((await req(a.jar, 'POST', `/api/notifications/deliveries/${delivery.id}/open`)).status).toBe(200)
      const first = (await testPrisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).openedAt
      expect(first).not.toBeNull()
      await req(a.jar, 'POST', `/api/notifications/deliveries/${delivery.id}/open`)
      expect((await testPrisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).openedAt).toEqual(first)
      expect((await req(a.jar, 'POST', '/api/notifications/deliveries/nope/open')).status).toBe(404)
    })
  })

  describe('POST /api/webhooks/email', () => {
    const secret = () => process.env.TEST_RESEND_WEBHOOK_SECRET!
    async function post(event: unknown, over: { secret?: string; skipHeaders?: boolean; tamper?: boolean; timestamp?: Date } = {}) {
      const body = JSON.stringify(event)
      const id = `msg_${Math.random().toString(36).slice(2)}`
      const ts = over.timestamp ?? new Date()
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': syntheticIp() }
      if (!over.skipHeaders) {
        headers['svix-id'] = id
        headers['svix-timestamp'] = String(Math.floor(ts.getTime() / 1000))
        headers['svix-signature'] = new Webhook(over.secret ?? secret()).sign(id, ts, body)
      }
      const res = await fetch(`${INTEGRATION_BASE_URL}/api/webhooks/email`, { method: 'POST', headers, body: over.tamper ? body.replace('bounced', 'bounceD') : body })
      return { status: res.status, data: await res.json() }
    }
    const bounce = (to: string) => ({ type: 'email.bounced', data: { email_id: 'em_x', to: [to], bounce: { type: 'Permanent' } } })

    it('suppresses the address of a permanent bounce, and of a complaint', async () => {
      const bounced = `ndr-bounce-${suffix}@test.dev`
      const complained = `ndr-complaint-${suffix}@test.dev`
      suppressedAddresses.push(bounced, complained)
      expect(await post(bounce(bounced))).toMatchObject({ status: 200, data: { handled: 'BOUNCE', addresses: 1 } })
      expect(await post({ type: 'email.complained', data: { email_id: 'em_y', to: [complained] } })).toMatchObject({ status: 200, data: { handled: 'COMPLAINT' } })
      const kept = await testPrisma.emailSuppression.findUnique({ where: { emailHash: suppressionKey(bounced) } })
      expect(kept).toMatchObject({ reason: 'BOUNCE' })
      // Only the hash is kept: nothing in the row, or anywhere in the table, is the address.
      expect(JSON.stringify(kept)).not.toContain(`ndr-bounce-${suffix}`)
      expect(await testPrisma.emailSuppression.findUnique({ where: { emailHash: suppressionKey(complained) } })).toMatchObject({ reason: 'COMPLAINT' })
      expect(await testPrisma.$queryRaw`SELECT 1 FROM "EmailSuppression" WHERE "emailHash" !~ '^[0-9a-f]{64}$'`).toHaveLength(0)
    })

    it('shows the person that mail to their address does not arrive', async () => {
      const a = await user('wh')
      const address = (await testPrisma.user.findUniqueOrThrow({ where: { id: a.userId } })).email
      suppressedAddresses.push(address)
      expect((await req(a.jar, 'GET', '/api/notifications/channels')).data.email.undeliverable).toBe(false)
      await post(bounce(address))
      expect((await req(a.jar, 'GET', '/api/notifications/channels')).data.email.undeliverable).toBe(true)
    })

    it('ignores events it does not act on', async () => {
      expect(await post({ type: 'email.delivered', data: { to: ['x@test.dev'] } })).toMatchObject({ status: 200, data: { handled: 'IGNORED' } })
      expect(await post({ type: 'email.bounced', data: { to: ['y@test.dev'], bounce: { type: 'Transient' } } })).toMatchObject({ status: 200, data: { handled: 'IGNORED' } })
      expect(await testPrisma.emailSuppression.count({ where: { emailHash: { in: ['x@test.dev', 'y@test.dev'].map(suppressionKey) } } })).toBe(0)
    })

    it('refuses an unsigned, wrongly signed, tampered or stale delivery', async () => {
      const event = bounce(`ndr-refused-${suffix}@test.dev`)
      expect((await post(event, { skipHeaders: true })).status).toBe(400)
      expect((await post(event, { secret: `whsec_${Buffer.from('a-different-secret-entirely-000000').toString('base64')}` })).status).toBe(400)
      expect((await post(event, { tamper: true })).status).toBe(400)
      expect((await post(event, { timestamp: new Date(Date.now() - 10 * 60_000) })).status).toBe(400)
      expect(await testPrisma.emailSuppression.count({ where: { emailHash: suppressionKey(`ndr-refused-${suffix}@test.dev`) } })).toBe(0)
    })
  })
})
