import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin } from './db'
import { INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL } from './config'

// GET /api/openapi.json: the committed document, for administrators (the suite runs a production build; in development any signed-in person may read it).
describe('GET /api/openapi.json', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let member: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`oa${suffix}@test.dev`, `oa${suffix}`)
    await promoteToAdmin(admin.userId)
    member = await registerAndLogin(`ob${suffix}@test.dev`, `ob${suffix}`)
  }, 120_000)
  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('serves the document to an administrator, byte for byte what is committed', async () => {
    const res = await req(admin.jar, 'GET', '/api/openapi.json')
    expect(res.status).toBe(200)
    const committed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/openapi.json'), 'utf-8'))
    expect(res.data).toEqual(committed)
    expect(res.data.openapi).toBe('3.1.0')
    expect(Object.keys(res.data.paths)).toContain('/api/openapi.json')
  })

  it('refuses everyone else: a member is 403, a stranger 401', async () => {
    const forbidden = await req(member.jar, 'GET', '/api/openapi.json')
    expect(forbidden.status).toBe(403)
    expect(forbidden.data.error.code).toBe('FORBIDDEN')
    const anonymous = await fetch(`${INTEGRATION_BASE_URL}/api/openapi.json`)
    expect(anonymous.status).toBe(401)
  })

  it('is cacheable by the one who may read it, and 304 when nothing changed', async () => {
    const token = (await admin.jar.token())!
    const first = await fetch(`${INTEGRATION_BASE_URL}/api/openapi.json`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': admin.jar.ip } })
    expect(first.headers.get('cache-control')).toBe('private, max-age=60')
    const tag = first.headers.get('etag')!
    await first.arrayBuffer()
    const second = await fetch(`${INTEGRATION_BASE_URL}/api/openapi.json`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': admin.jar.ip, 'if-none-match': tag } })
    expect(second.status).toBe(304)
  })
})
