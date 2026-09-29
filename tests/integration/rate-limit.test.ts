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

  async function credentialsLoginAttempt(email: string, password: string, ip: string, cookieAndCsrf: { cookie: string; csrf: string }) {
    const form = new URLSearchParams({ email, password, csrfToken: cookieAndCsrf.csrf, json: 'true' })
    return fetch(INTEGRATION_BASE_URL + '/api/auth/callback/credentials', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieAndCsrf.cookie,
        'x-forwarded-for': ip,
      },
      body: form.toString(),
      redirect: 'manual',
    })
  }

  it('throttles password guessing against one account even when the attacker rotates IPs', async () => {
    const victimEmail = `rl.victim.${suffix}@test.dev`
    await registerAndLogin(victimEmail, `rlvictim${suffix}`)

    const csrfRes = await fetch(INTEGRATION_BASE_URL + '/api/auth/csrf', { headers: { 'x-forwarded-for': syntheticIp() } })
    const { csrfToken } = await csrfRes.json()
    const cookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

    const statuses: number[] = []
    let retryAfter: string | null = null
    for (let i = 0; i < 14; i++) {
      // A brand-new source address on every attempt.
      const res = await credentialsLoginAttempt(victimEmail, `wrong-password-${i}`, syntheticIp(), { cookie, csrf: csrfToken })
      statuses.push(res.status)
      if (res.status === 429) retryAfter = res.headers.get('retry-after')
    }

    expect(statuses[0]).not.toBe(429)
    expect(statuses).toContain(429)
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
  })

  it('does not let the throttled account lock out other accounts', async () => {
    const other = await registerAndLogin(`rl.bystander.${suffix}@test.dev`, `rlbystander${suffix}`)
    const me = await req(other.jar, 'GET', '/api/notifications')
    expect(me.status).toBe(200)
  })

  it('cannot be bypassed by forging the left side of X-Forwarded-For', async () => {
    const proxyAppended = syntheticIp()
    const statuses: number[] = []
    for (let i = 0; i < 13; i++) {
      // register is limited to 10/min per client address; an empty body is
      // rejected by validation but still counts against the limiter.
      const forgedLeft = `${Math.floor(Math.random() * 223) + 1}.${i}.${i}.1`
      const res = await req(null, 'POST', '/api/auth/register', {}, { 'x-forwarded-for': `${forgedLeft}, ${proxyAppended}` })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true)
    expect(statuses.slice(10)).toContain(429)
  })

  it('does not throttle genuinely different clients against each other', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 13; i++) {
      const res = await req(null, 'POST', '/api/auth/register', {}, { 'x-forwarded-for': syntheticIp() })
      statuses.push(res.status)
    }
    expect(statuses.every((s) => s === 400)).toBe(true)
  })

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
