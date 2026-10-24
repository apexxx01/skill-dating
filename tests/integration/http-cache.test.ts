import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers } from './db'
import { registerAndLogin, uniqueSuffix, type TestUser } from './helpers'

// The caching headers of the read-heavy GETs (src/lib/api/http-cache.ts): private, a short max-age, an ETag, and a 304 with no body for a client that already has the answer.
describe('HTTP caching of read-heavy answers', () => {
  const suffix = uniqueSuffix()
  let ada: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    ada = await registerAndLogin(`hc${suffix}@test.dev`, `hc${suffix}`)
  }, 120_000)
  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 120_000)

  /** A GET with the person's session and extra headers; the cookie jar makes the token. */
  async function get(path: string, headers: Record<string, string> = {}) {
    const token = (await ada.jar.token())!
    return fetch(`${INTEGRATION_BASE_URL}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ada.jar.ip, ...headers } })
  }

  it('sends a private max-age, an ETag and Vary on a cached route', async () => {
    const res = await get('/api/skills')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=300')
    expect(res.headers.get('etag')).toMatch(/^W\/"/)
    expect(res.headers.get('vary')).toMatch(/Authorization/i)
    expect(await res.json()).toBeTruthy()
  })

  it('answers 304 with no body to a client that has the answer (also when it revalidates with no-cache, as a conditional fetch does), and the body to one that has another', async () => {
    const first = await get('/api/skills')
    const tag = first.headers.get('etag')!
    await first.arrayBuffer()
    const same = await get('/api/skills', { 'if-none-match': tag })
    expect(same.status).toBe(304)
    expect(await same.text()).toBe('')
    expect(same.headers.get('etag')).toBe(tag)
    const revalidated = await get('/api/skills', { 'if-none-match': tag, 'cache-control': 'no-cache' })
    expect(revalidated.status).toBe(304)
    const other = await get('/api/skills', { 'if-none-match': 'W/"something-else"' })
    expect(other.status).toBe(200)
  })

  it('asks to be revalidated every time on the routes whose answer changes under the person', async () => {
    for (const path of ['/api/notifications', '/api/dashboard']) {
      const res = await get(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control'), path).toBe('private, max-age=0, must-revalidate')
      expect(res.headers.get('etag'), path).toBeTruthy()
    }
  })

  it('never caches today’s drops (reading them marks them as seen) or an error', async () => {
    const drops = await get('/api/drops/today')
    expect(drops.status).toBe(200)
    expect(drops.headers.get('etag')).toBeNull()
    expect(drops.headers.get('cache-control') ?? '').not.toMatch(/max-age=[1-9]/)
    const missing = await get('/api/users/does-not-exist-anywhere')
    expect(missing.status).toBeGreaterThanOrEqual(400)
    expect(missing.headers.get('etag')).toBeNull()
  })
})
