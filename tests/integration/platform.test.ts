import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { registerAndLogin, uniqueSuffix, req, syntheticIp, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { loadEnvLocal } from './env'
import { bornYearsAgo } from './matching-fixtures'
import { INTEGRATION_DATABASE_URL } from './config'

Object.assign(process.env, { ...loadEnvLocal(), DATABASE_URL: INTEGRATION_DATABASE_URL })

// Feature flags, health, request ids, entitlements and analytics through the real server.
describe('platform layer', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let member: TestUser
  const flagKey = (name: string) => `${name}-${suffix}`

  beforeAll(async () => {
    admin = await registerAndLogin(`plat.admin.${suffix}@test.dev`, `platadmin${suffix}`)
    member = await registerAndLogin(`plat.member.${suffix}@test.dev`, `platmember${suffix}`)
    await promoteToAdmin(admin.userId)
  }, 120_000)

  afterAll(async () => {
    await testPrisma.featureFlag.deleteMany({ where: { key: { endsWith: suffix } } })
    await cleanupTestUsers(suffix)
  })

  describe('feature flags', () => {
    it('are admin-only: a member gets 403 on every admin route', async () => {
      expect((await req(member.jar, 'GET', '/api/admin/flags')).status).toBe(403)
      expect((await req(member.jar, 'POST', '/api/admin/flags', { key: flagKey('nope') })).status).toBe(403)
      expect((await req(member.jar, 'GET', `/api/admin/flags/${flagKey('nope')}`)).status).toBe(403)
      expect((await req(member.jar, 'PATCH', `/api/admin/flags/${flagKey('nope')}`, { enabled: true })).status).toBe(403)
      expect((await req(member.jar, 'DELETE', `/api/admin/flags/${flagKey('nope')}`)).status).toBe(403)
      expect((await req(null, 'GET', '/api/admin/flags')).status).toBe(401)
      expect(await testPrisma.featureFlag.count({ where: { key: flagKey('nope') } })).toBe(0)
    })

    it('can be created, read, changed and deleted by an admin, with an audit trail', async () => {
      const key = flagKey('crud')
      const created = await req(admin.jar, 'POST', '/api/admin/flags', { key, description: 'A test flag', enabled: true, rolloutPercent: 50 })
      expect(created.status).toBe(201)
      expect(created.data).toMatchObject({ key, description: 'A test flag', enabled: true, rolloutPercent: 50, allowUserIds: [], updatedById: admin.userId })
      expect(created.data.id).toBeUndefined()

      expect((await req(admin.jar, 'GET', `/api/admin/flags/${key}`)).data.key).toBe(key)

      const patched = await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { rolloutPercent: 75, allowUserIds: [member.userId], description: null })
      expect(patched.status).toBe(200)
      expect(patched.data).toMatchObject({ rolloutPercent: 75, allowUserIds: [member.userId], description: null, enabled: true })

      expect((await req(admin.jar, 'DELETE', `/api/admin/flags/${key}`)).data).toEqual({ success: true })
      expect((await req(admin.jar, 'GET', `/api/admin/flags/${key}`)).status).toBe(404)

      const actions = (await testPrisma.auditEvent.findMany({ where: { targetType: 'FEATURE_FLAG', targetId: key }, orderBy: { createdAt: 'asc' } })).map((event) => event.action)
      expect(actions).toEqual(['FEATURE_FLAG_CREATED', 'FEATURE_FLAG_UPDATED', 'FEATURE_FLAG_DELETED'])
    })

    it('reject a duplicate key, a bad key and bad values with the error contract', async () => {
      const key = flagKey('dupe')
      expect((await req(admin.jar, 'POST', '/api/admin/flags', { key })).status).toBe(201)
      const dupe = await req(admin.jar, 'POST', '/api/admin/flags', { key })
      expect(dupe.status).toBe(409)
      expect(dupe.data.error.code).toBe('FLAG_EXISTS')

      const badKey = await req(admin.jar, 'POST', '/api/admin/flags', { key: 'Bad Key!' })
      expect(badKey.status).toBe(400)
      expect(badKey.data.error.code).toBe('VALIDATION_FAILED')
      expect((await req(admin.jar, 'POST', '/api/admin/flags', { key: flagKey('range'), rolloutPercent: 101 })).status).toBe(400)
      expect((await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { rolloutPercent: -1 })).status).toBe(400)

      const missing = await req(admin.jar, 'PATCH', `/api/admin/flags/${flagKey('missing')}`, { enabled: true })
      expect(missing.status).toBe(404)
      expect(missing.data.error.code).toBe('FLAG_NOT_FOUND')
      expect((await req(admin.jar, 'GET', '/api/admin/flags/Bad%20Key')).data.error.code).toBe('FLAG_NOT_FOUND')
    })

    it('reach the user the moment an admin changes them: off, then on for all, then rolled out, then allowlisted', async () => {
      const key = flagKey('eval')
      const mine = async () => (await req(member.jar, 'GET', '/api/flags')).data.flags[key]

      expect(await mine()).toBeUndefined()
      await req(admin.jar, 'POST', '/api/admin/flags', { key, enabled: false })
      expect(await mine()).toBe(false)

      await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { enabled: true })
      expect(await mine()).toBe(true)

      await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { rolloutPercent: 0 })
      expect(await mine()).toBe(false)

      // Allowlisted users are in whatever the percentage says, and even while the flag is off.
      await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { allowUserIds: [member.userId] })
      expect(await mine()).toBe(true)
      await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { enabled: false })
      expect(await mine()).toBe(true)
      expect((await req(admin.jar, 'GET', '/api/flags')).data.flags[key]).toBe(false)

      await req(admin.jar, 'DELETE', `/api/admin/flags/${key}`)
      expect(await mine()).toBeUndefined()
    })

    it('give a stable answer per user at a partial rollout, and only expose keys and booleans', async () => {
      const key = flagKey('partial')
      await req(admin.jar, 'POST', '/api/admin/flags', { key, enabled: true, rolloutPercent: 50, allowUserIds: [admin.userId] })
      const first = (await req(member.jar, 'GET', '/api/flags')).data.flags[key]
      for (let index = 0; index < 3; index++) expect((await req(member.jar, 'GET', '/api/flags')).data.flags[key]).toBe(first)
      expect(typeof first).toBe('boolean')

      const body = JSON.stringify((await req(member.jar, 'GET', '/api/flags')).data)
      expect(body).not.toContain(admin.userId)
      expect(body).not.toContain('rolloutPercent')
    })
  })

  describe('health', () => {
    it('is public, reports every dependency, and shows no secrets or addresses', async () => {
      const res = await fetch(INTEGRATION_BASE_URL + '/api/health', { headers: { 'x-forwarded-for': syntheticIp() } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-request-id')).toBeTruthy()
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(Object.keys(body.checks).sort()).toEqual(['cache', 'database', 'jobs', 'realtime'])
      expect(body.checks.database).toMatchObject({ status: 'ok', provider: 'postgres' })
      for (const check of Object.values(body.checks) as { status: string; provider: string }[]) {
        expect(check.status).toBe('ok')
        expect(['postgres', 'memory', 'upstash', 'inngest', 'ably']).toContain(check.provider)
      }
      const text = JSON.stringify(body)
      expect(text).not.toMatch(/postgres(ql)?:\/\/|sk_|pk_|whsec_|password|secret|token|localhost/i)
      expect(new Date(body.time).getTime()).toBeGreaterThan(Date.now() - 60_000)
    })
  })

  describe('request ids', () => {
    it('come back on every response, and a plausible incoming id is kept', async () => {
      const own = await req(member.jar, 'GET', '/api/users/me')
      expect(own.status).toBe(200)

      const token = await member.jar.token()
      const kept = await fetch(INTEGRATION_BASE_URL + '/api/users/me', { headers: { Authorization: `Bearer ${token}`, 'x-request-id': `trace-${suffix}-keep`, 'x-forwarded-for': member.jar.ip } })
      expect(kept.headers.get('x-request-id')).toBe(`trace-${suffix}-keep`)

      const anonymous = await fetch(INTEGRATION_BASE_URL + '/api/users/me', { headers: { 'x-forwarded-for': syntheticIp() } })
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)

      const replaced = await fetch(INTEGRATION_BASE_URL + '/api/users/me', { headers: { 'x-request-id': 'bad id with spaces', 'x-forwarded-for': syntheticIp() } })
      expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  describe('time zones', () => {
    it('accept an IANA zone on the profile and refuse anything else', async () => {
      expect((await req(member.jar, 'PATCH', '/api/users', { timezone: 'Asia/Kolkata' })).data.timezone).toBe('Asia/Kolkata')
      const bad = await req(member.jar, 'PATCH', '/api/users', { timezone: 'Mars/Olympus' })
      expect(bad.status).toBe(400)
      expect(bad.data.error.code).toBe('VALIDATION_FAILED')
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: member.userId } })).timezone).toBe('Asia/Kolkata')
    })
  })

  describe('analytics', () => {
    it('records signup for a new account, once, with no personal data', async () => {
      const events = await testPrisma.productEvent.findMany({ where: { userId: member.userId, name: 'signup' } })
      expect(events).toHaveLength(1)
      expect(JSON.stringify(events[0].props ?? {})).not.toContain('@')
    })

    it('records onboarding_completed once, when the headline and a skill are both there', async () => {
      const skill = await testPrisma.skill.create({ data: { name: `Plat Skill ${suffix}`, slug: `plat-skill-${suffix}`, category: 'PlatTest' } })
      const count = () => testPrisma.productEvent.count({ where: { userId: member.userId, name: 'onboarding_completed' } })

      expect((await req(member.jar, 'PATCH', '/api/users', { headline: 'Builder' })).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await count()).toBe(0) // no skill yet

      expect((await req(member.jar, 'POST', `/api/users/${member.userId}/skills`, { skillId: skill.id, level: 3 })).status).toBe(201)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await count()).toBe(0) // onboarding also needs a date of birth (the age policy)

      expect((await req(member.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(25), headline: 'Builder' })).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await count()).toBe(1)

      await req(member.jar, 'PATCH', '/api/users', { headline: 'Builder, edited' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await count()).toBe(1)
      await testPrisma.skill.deleteMany({ where: { slug: `plat-skill-${suffix}` } })
    })
  })

  describe('entitlements', () => {
    it('treat everyone as FREE with enforcement off, and read the plan from the subscription', async () => {
      const { subjectFor, can, limit, ENTITLEMENTS } = await import('../../src/lib/entitlements')

      expect(await subjectFor(testPrisma, member.userId)).toEqual({ plan: 'FREE' })
      expect(can({ plan: 'FREE' }, 'SEE_WHO_SPARKED', { enforced: false })).toBe(true)

      await testPrisma.subscription.create({ data: { userId: member.userId, plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86_400_000) } })
      expect(await subjectFor(testPrisma, member.userId)).toEqual({ plan: 'PRO' })
      expect(limit({ plan: 'PRO' }, 'DAILY_DROPS', { enforced: true })).toBe(ENTITLEMENTS.DAILY_DROPS.plans.PRO)

      await testPrisma.subscription.update({ where: { userId: member.userId }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } })
      expect(await subjectFor(testPrisma, member.userId)).toEqual({ plan: 'FREE' })
      await testPrisma.subscription.delete({ where: { userId: member.userId } })
    })

    it('allow one subscription per user', async () => {
      await testPrisma.subscription.create({ data: { userId: member.userId } })
      await expect(testPrisma.subscription.create({ data: { userId: member.userId, plan: 'PRO' } })).rejects.toThrow()
      await testPrisma.subscription.delete({ where: { userId: member.userId } })
    })
  })
})
