import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { cookieJar, req, registerAndLogin, syntheticIp, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { createClerkUser, createSession, mintToken } from './clerk-api'
import { INTEGRATION_DATABASE_URL } from './config'
import { SIGNUP_LIMIT } from '../../src/lib/identity/signup'

// Sign-up abuse and identity (src/lib/identity): the sign-ups kill switch, throwaway domains, the per-address limit on new accounts, and usernames that are
// reserved or read like somebody else's. A refused sign-up leaves no local account behind.
describe('sign-up abuse and identity', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser

  /** A new Clerk account and its first request to the API, from `ip`. */
  async function firstRequest(email: string, username: string, ip: string = syntheticIp()) {
    const clerk = await createClerkUser(email, username)
    const session = await createSession(clerk.clerkId)
    const jar = cookieJar(ip, () => mintToken(session))
    return { clerkId: clerk.clerkId, res: await req(jar, 'GET', '/api/users/me') }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`sga${suffix}@test.dev`, `sga${suffix}`)
    await promoteToAdmin(admin.userId)
  }, 60_000)

  afterAll(async () => {
    await testPrisma.featureFlag.updateMany({ where: { key: 'kill.signups' }, data: { enabled: false } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('refuses every new account while sign-ups are paused, and creates nothing', async () => {
    expect((await req(admin.jar, 'PATCH', '/api/admin/flags/kill.signups', { enabled: true })).status).toBe(200)
    const { clerkId, res } = await firstRequest(`sgp${suffix}@test.dev`, `sgp${suffix}`)
    expect(res.status).toBe(503)
    expect(res.data.error.code).toBe('SIGNUPS_PAUSED')
    expect(await testPrisma.user.count({ where: { clerkId } })).toBe(0)
    // An existing account is not affected.
    expect((await req(admin.jar, 'GET', '/api/users/me')).status).toBe(200)
    await req(admin.jar, 'PATCH', '/api/admin/flags/kill.signups', { enabled: false })
  })

  it('refuses a throwaway e-mail domain', async () => {
    const { clerkId, res } = await firstRequest(`sgd${suffix}@mailinator.com`, `sgd${suffix}`)
    expect(res.status).toBe(403)
    expect(res.data.error.code).toBe('SIGNUP_EMAIL_REJECTED')
    expect(await testPrisma.user.count({ where: { clerkId } })).toBe(0)
  })

  it('limits new accounts from one address', async () => {
    const ip = syntheticIp()
    const statuses: number[] = []
    for (let i = 0; i <= SIGNUP_LIMIT.maxRequests; i++) statuses.push((await firstRequest(`sgl${i}${suffix}@test.dev`, `sgl${i}${suffix}`, ip)).res.status)
    expect(statuses.slice(0, SIGNUP_LIMIT.maxRequests).every((s) => s === 200)).toBe(true)
    expect(statuses[SIGNUP_LIMIT.maxRequests]).toBe(429)
  }, 180_000)

  it('gives a name that reads like somebody else’s a suffix, so it cannot pass for them', async () => {
    await testPrisma.user.create({ data: { email: `sgm${suffix}@test.dev`, username: `mark${suffix}`, usernameSkeleton: null } })
    // The skeleton of the existing name is what the check compares; the backfill fills it for old rows.
    await testPrisma.$executeRawUnsafe(`UPDATE "User" SET "usernameSkeleton" = replace(replace(replace(regexp_replace(translate(lower("username"), '01345789|$@i', 'oleastbglsal'), '[_.[:space:]-]', '', 'g'), 'rn', 'm'), 'vv', 'w'), 'cl', 'd') WHERE "username" = $1`, `mark${suffix}`)
    const { res } = await firstRequest(`sgn${suffix}@test.dev`, `rnark${suffix}`)
    expect(res.status).toBe(200)
    expect(res.data.username).not.toBe(`rnark${suffix}`)
    expect(res.data.username.startsWith(`rnark${suffix}`.slice(0, 10))).toBe(true)
  })
})
