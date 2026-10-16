import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'

describe('profile settings: time zone, place and privacy', () => {
  const suffix = uniqueSuffix()
  let n = 0
  afterAll(() => cleanupTestUsers(suffix))
  const user = () => {
    const name = `ps${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  it('needs a signed-in user', async () => {
    expect((await req(null, 'GET', '/api/users/me/profile')).status).toBe(401)
    expect((await req(null, 'PATCH', '/api/users/me/profile', { city: 'Pune' })).status).toBe(401)
  })

  it('answers with the defaults before anything was saved, and creates no profile for a read', async () => {
    const u = await user()
    const res = await req(u.jar, 'GET', '/api/users/me/profile')
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ timezone: null, countryCode: null, city: null, campus: null, hideFromLeaderboards: false, showActivity: true })
    expect(await testPrisma.profile.count({ where: { userId: u.userId } })).toBe(0)
  })

  it('saves tidied place text with its comparable key, an upper-case country and the time zone', async () => {
    const u = await user()
    const res = await req(u.jar, 'PATCH', '/api/users/me/profile', {
      timezone: 'Asia/Kolkata',
      countryCode: 'in',
      city: '  Bengaluru ',
      campus: 'IISc   Bangalore',
      hideFromLeaderboards: true,
      showActivity: false,
    })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ timezone: 'Asia/Kolkata', countryCode: 'IN', city: 'Bengaluru', campus: 'IISc Bangalore', hideFromLeaderboards: true, showActivity: false })

    expect(await testPrisma.profile.findUnique({ where: { userId: u.userId } })).toMatchObject({ countryCode: 'IN', cityKey: 'bengaluru', campusKey: 'iisc-bangalore' })
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).timezone).toBe('Asia/Kolkata')
    expect((await req(u.jar, 'GET', '/api/users/me/profile')).data).toEqual(res.data)
  })

  it('changes only what is sent, and clears a field sent as null', async () => {
    const u = await user()
    await req(u.jar, 'PATCH', '/api/users/me/profile', { countryCode: 'US', city: 'Austin', campus: 'UT Austin' })
    const second = await req(u.jar, 'PATCH', '/api/users/me/profile', { city: 'Dallas' })
    expect(second.data).toMatchObject({ countryCode: 'US', city: 'Dallas', campus: 'UT Austin' })

    const cleared = await req(u.jar, 'PATCH', '/api/users/me/profile', { campus: null, countryCode: null })
    expect(cleared.data).toMatchObject({ countryCode: null, city: 'Dallas', campus: null })
    expect(await testPrisma.profile.findUnique({ where: { userId: u.userId } })).toMatchObject({ campusKey: null })
  })

  it('refuses a country that is not assigned, a bad time zone, unknown fields and an empty body', async () => {
    const u = await user()
    for (const body of [{ countryCode: 'XX' }, { countryCode: 'India' }, { timezone: 'Mars/Olympus' }, { hideFromLeaderboards: 'yes' }, {}, { xp: 99999 }, { role: 'ADMIN' }]) {
      const res = await req(u.jar, 'PATCH', '/api/users/me/profile', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.data.error.code).toBe('VALIDATION_FAILED')
    }
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).role).toBe('USER')
    expect((await req(u.jar, 'PATCH', '/api/users/me/profile', 'not json' as unknown as object)).status).toBe(400)
  })

  it('keeps one user from touching another: there is no way to name someone else', async () => {
    const a = await user()
    const b = await user()
    await req(a.jar, 'PATCH', '/api/users/me/profile', { city: 'Mumbai', hideFromLeaderboards: true })
    expect((await req(b.jar, 'GET', '/api/users/me/profile')).data).toMatchObject({ city: null, hideFromLeaderboards: false })
  })
})
