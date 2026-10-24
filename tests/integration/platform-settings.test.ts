import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL } from './config'
import { registerAndLogin, uniqueSuffix, req, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { loadEnvLocal } from './env'

Object.assign(process.env, { ...loadEnvLocal(), DATABASE_URL: INTEGRATION_DATABASE_URL })
void INTEGRATION_BASE_URL

const KEY = 'romance.launch-threshold'

describe('admin settings: the romance launch threshold', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let member: TestUser

  beforeAll(async () => {
    admin = await registerAndLogin(`set.admin.${suffix}@test.dev`, `setadmin${suffix}`)
    member = await registerAndLogin(`set.member.${suffix}@test.dev`, `setmember${suffix}`)
    await promoteToAdmin(admin.userId)
    await testPrisma.platformSetting.deleteMany({ where: { key: KEY } })
  }, 120_000)

  afterAll(async () => {
    await testPrisma.platformSetting.deleteMany({ where: { key: KEY } })
    await cleanupTestUsers(suffix)
  })

  it('is admin only', async () => {
    expect((await req(member.jar, 'GET', '/api/admin/settings')).status).toBe(403)
    expect((await req(member.jar, 'PUT', `/api/admin/settings/${KEY}`, { value: { minInterestedAdults: 1, minPairingSharePercent: 0 } })).status).toBe(403)
    expect((await req(null, 'GET', '/api/admin/settings')).status).toBe(401)
    expect(await testPrisma.platformSetting.count({ where: { key: KEY } })).toBe(0)
  })

  it('starts at 250 and 30, changes with an audit trail, and is read back', async () => {
    const before = await req(admin.jar, 'GET', '/api/admin/settings')
    expect(before.status).toBe(200)
    const setting = before.data.settings.find((s: { key: string }) => s.key === KEY)
    expect(setting).toMatchObject({ value: { minInterestedAdults: 250, minPairingSharePercent: 30 }, default: { minInterestedAdults: 250, minPairingSharePercent: 30 }, isDefault: true, updatedAt: null })

    const changed = await req(admin.jar, 'PUT', `/api/admin/settings/${KEY}`, { value: { minInterestedAdults: 400, minPairingSharePercent: 35 } })
    expect(changed.status).toBe(200)
    expect(changed.data).toMatchObject({ key: KEY, value: { minInterestedAdults: 400, minPairingSharePercent: 35 }, isDefault: false, updatedById: admin.userId })

    const after = await req(admin.jar, 'GET', '/api/admin/settings')
    expect(after.data.settings.find((s: { key: string }) => s.key === KEY).value).toEqual({ minInterestedAdults: 400, minPairingSharePercent: 35 })

    const events = await testPrisma.auditEvent.findMany({ where: { targetType: 'PLATFORM_SETTING', targetId: KEY, userId: admin.userId } })
    expect(events.map((e) => e.action)).toEqual(['PLATFORM_SETTING_UPDATED'])
    expect(events[0].oldValue).toEqual({ value: { minInterestedAdults: 250, minPairingSharePercent: 30 } })
    expect(events[0].newValue).toEqual({ value: { minInterestedAdults: 400, minPairingSharePercent: 35 } })
  })

  it('refuses a bad value, an extra key and an unknown setting with the error contract', async () => {
    for (const value of [{ minInterestedAdults: 0, minPairingSharePercent: 30 }, { minInterestedAdults: 250, minPairingSharePercent: 60 }, { minInterestedAdults: 250, minPairingSharePercent: 30, extra: true }, 'many']) {
      const res = await req(admin.jar, 'PUT', `/api/admin/settings/${KEY}`, { value })
      expect(res.status, JSON.stringify(value)).toBe(400)
      expect(res.data.error.code).toBe('VALIDATION_FAILED')
      expect(res.data.error.details.value.length).toBeGreaterThan(0)
    }
    const unknown = await req(admin.jar, 'PUT', '/api/admin/settings/nope', { value: 1 })
    expect(unknown.status).toBe(404)
    expect(unknown.data.error.code).toBe('SETTING_NOT_FOUND')
  })
})
