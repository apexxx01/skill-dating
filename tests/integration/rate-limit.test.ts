import { describe, it, expect, afterAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { req, registerAndLogin, syntheticIp, uniqueSuffix } from './helpers'
import { cleanupTestUsers } from './db'

// The server under test trusts exactly one proxy hop (TRUSTED_PROXY_HOPS=1):
// the LAST X-Forwarded-For entry is what our proxy appended and is the only
// one a client cannot forge.
describe('rate limiting', () => {
  const suffix = uniqueSuffix()

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  // Signed-out callers share the anonymous flood bucket: 120 requests a minute per
  // client address, however the request is shaped. /api/users/me needs a session,
  // so every request here is refused with 401 until the bucket runs out.
  const ANONYMOUS_LIMIT = 120

  async function floodAnonymously(headers: () => Record<string, string>, count: number) {
    const statuses: number[] = []
    for (let i = 0; i < count; i++) statuses.push((await req(null, 'GET', '/api/users/me', undefined, headers())).status)
    return statuses
  }

  it('cannot be bypassed by forging the left side of X-Forwarded-For', async () => {
    const proxyAppended = syntheticIp()
    let i = 0
    const statuses = await floodAnonymously(() => {
      // A different forged client address on every request; only the entry our proxy appended counts.
      const forgedLeft = `${Math.floor(Math.random() * 223) + 1}.${i++ % 250}.${i % 250}.1`
      return { 'x-forwarded-for': `${forgedLeft}, ${proxyAppended}` }
    }, ANONYMOUS_LIMIT + 5)
    expect(statuses.slice(0, ANONYMOUS_LIMIT).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(ANONYMOUS_LIMIT).every((s) => s === 429)).toBe(true)
  }, 60_000)

  it('does not throttle genuinely different clients against each other', async () => {
    const busy = syntheticIp()
    const busyStatuses = await floodAnonymously(() => ({ 'x-forwarded-for': busy }), ANONYMOUS_LIMIT + 5)
    expect(busyStatuses).toContain(429)

    for (let client = 0; client < 3; client++) {
      const res = await req(null, 'GET', '/api/users/me', undefined, { 'x-forwarded-for': syntheticIp() })
      expect(res.status).toBe(401)
    }
  }, 60_000)

  it('does not let a flood of signed-out requests lock out a signed-in user on the same address', async () => {
    const other = await registerAndLogin(`rl.bystander.${suffix}@test.dev`, `rlbystander${suffix}`)
    const shared = syntheticIp()
    await floodAnonymously(() => ({ 'x-forwarded-for': shared }), ANONYMOUS_LIMIT + 5)
    // Signed-in traffic is limited per user id, not by the anonymous bucket.
    const me = await req(other.jar, 'GET', '/api/notifications', undefined, { 'x-forwarded-for': shared })
    expect(me.status).toBe(200)
  }, 60_000)

  it('limits authenticated routes per user, not per IP', async () => {
    const heavy = await registerAndLogin(`rl.heavy.${suffix}@test.dev`, `rlheavy${suffix}`)
    const light = await registerAndLogin(`rl.light.${suffix}@test.dev`, `rllight${suffix}`)

    // POST /api/reports allows 10/min per user. A self-report is rejected
    // with 400 but still consumes the budget.
    const heavyStatuses: number[] = []
    let last429: { status: number; retryAfter: string | null; body: any } | null = null
    for (let i = 0; i < 13; i++) {
      // Rotating the source address must not help the heavy user.
      const res = await req(heavy.jar, 'POST', '/api/reports', { reportedId: heavy.userId, reason: 'SPAM' }, { 'x-forwarded-for': syntheticIp() })
      heavyStatuses.push(res.status)
      if (res.status === 429) last429 = { status: res.status, retryAfter: null, body: res.data }
    }
    expect(heavyStatuses.slice(0, 10).every((s) => s === 400)).toBe(true)
    expect(heavyStatuses).toContain(429)
    expect(last429?.body.error).toBe('Too many requests')
    expect(last429?.body.retryAfter).toBeGreaterThanOrEqual(1)

    // A different user arriving from the SAME address is unaffected.
    const shared = await req(light.jar, 'POST', '/api/reports', { reportedId: light.userId, reason: 'SPAM' }, { 'x-forwarded-for': heavy.jar.ip })
    expect(shared.status).toBe(400)
  })

  it('returns a Retry-After header on 429 responses', async () => {
    const user = await registerAndLogin(`rl.header.${suffix}@test.dev`, `rlheader${suffix}`)
    let header: string | null = null
    await user.jar.refresh()
    for (let i = 0; i < 13; i++) {
      const res = await fetch(INTEGRATION_BASE_URL + '/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: user.jar.header(), 'x-forwarded-for': user.jar.ip },
        body: JSON.stringify({ reportedId: user.userId, reason: 'SPAM' }),
      })
      if (res.status === 429) header = res.headers.get('retry-after')
    }
    expect(Number(header)).toBeGreaterThanOrEqual(1)
  })
})
