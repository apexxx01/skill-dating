import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { registerAndLogin, syntheticIp, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers } from './db'
import { auditAllRoutes } from '../../src/lib/api/route-audit'
import { PUBLIC_ROUTES } from '../../src/lib/api/rate-limit-classes'
import { MAX_BODY_BYTES } from '../../src/lib/api/limits'

// The authorization audit against the running server (the static half is src/lib/api/route-audit.test.ts): every API route, found from the file system,
// refuses an anonymous caller unless it is on the public allowlist, and every admin route refuses a signed-in person who is not staff.
const routes = auditAllRoutes().map((r) => ({ method: r.method, template: r.path, path: r.path.replace(/\[\[?\.\.\.[^\]]+\]?\]/g, 'x/y').replace(/\[[^\]]+\]/g, 'x') }))

async function call(method: string, path: string, token?: string, body = '{}') {
  const headers: Record<string, string> = { 'x-forwarded-for': syntheticIp(), 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(INTEGRATION_BASE_URL + path, { method, headers, body: method === 'GET' ? undefined : body, redirect: 'manual' })
  return { status: res.status, body: await res.text() }
}

describe('route authorization', () => {
  const suffix = uniqueSuffix()
  let member: TestUser

  beforeAll(async () => {
    member = await registerAndLogin(`raz${suffix}@test.dev`, `raz${suffix}`)
  }, 60_000)
  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 60_000)

  it('refuses an anonymous caller on every route but the public allowlist', async () => {
    const open: string[] = []
    for (const route of routes) {
      if (PUBLIC_ROUTES.has(route.template)) continue
      const res = await call(route.method, route.path)
      if (res.status !== 401) open.push(`${route.method} ${route.path} -> ${res.status}`)
    }
    expect(open).toEqual([])
  }, 300_000)

  it('refuses a signed-in person who is not staff on every admin route', async () => {
    const token = (await member.jar.token())!
    const open: string[] = []
    for (const route of routes.filter((r) => r.path.startsWith('/api/admin/'))) {
      const res = await call(route.method, route.path, token)
      if (res.status !== 403) open.push(`${route.method} ${route.path} -> ${res.status}`)
    }
    expect(open).toEqual([])
  }, 300_000)

  it('refuses a body over the size limit before reading it', async () => {
    const token = (await member.jar.token())!
    const res = await call('POST', '/api/posts', token, JSON.stringify({ body: 'x'.repeat(MAX_BODY_BYTES + 10) }))
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body).error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})
