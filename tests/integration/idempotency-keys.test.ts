import { describe, it, expect, afterAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { registerAndLogin, uniqueSuffix, req, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'

// POST routes that create things honour an Idempotency-Key header: a repeated
// request returns the first response instead of creating twice.
describe('Idempotency-Key', () => {
  const suffix = uniqueSuffix()
  let counter = 0
  const key = () => `idem-key-${suffix}-${counter++}`

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  const post = (user: TestUser, path: string, body: unknown, idempotencyKey?: string) =>
    req(user.jar, 'POST', path, body, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})

  async function rawPost(user: TestUser, path: string, body: unknown, idempotencyKey: string) {
    const token = await user.jar.token()
    const res = await fetch(INTEGRATION_BASE_URL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey, 'x-forwarded-for': user.jar.ip },
      body: JSON.stringify(body),
    })
    return { status: res.status, headers: res.headers, data: await res.json() }
  }

  it('creates once and replays the same response for the same key and body', async () => {
    const user = await registerAndLogin(`idk.a.${suffix}@test.dev`, `idka${suffix}`)
    const k = key()
    const body = { name: `Idempotent Project ${suffix}` }

    const first = await rawPost(user, '/api/projects', body, k)
    const second = await rawPost(user, '/api/projects', body, k)
    const third = await rawPost(user, '/api/projects', body, k)

    expect(first.status).toBe(201)
    expect(first.headers.get('idempotent-replayed')).toBeNull()
    for (const replay of [second, third]) {
      expect(replay.status).toBe(201)
      expect(replay.headers.get('idempotent-replayed')).toBe('true')
      expect(replay.data).toEqual(first.data)
    }
    expect(await testPrisma.project.count({ where: { ownerId: user.userId } })).toBe(1)
    // And the rewards of that one creation were paid once.
    expect(await testPrisma.xPEvent.count({ where: { userId: user.userId, type: 'PROJECT_CREATED' } })).toBe(1)
  })

  it('answers 409 when the key is reused with a different body', async () => {
    const user = await registerAndLogin(`idk.b.${suffix}@test.dev`, `idkb${suffix}`)
    const k = key()
    expect((await post(user, '/api/projects', { name: `First Body ${suffix}` }, k)).status).toBe(201)

    const clash = await post(user, '/api/projects', { name: `Other Body ${suffix}` }, k)
    expect(clash.status).toBe(409)
    expect(clash.data.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(await testPrisma.project.count({ where: { ownerId: user.userId } })).toBe(1)
  })

  it('answers 409 when the key is reused on a different route', async () => {
    const user = await registerAndLogin(`idk.c.${suffix}@test.dev`, `idkc${suffix}`)
    const k = key()
    expect((await post(user, '/api/projects', { name: `Route A ${suffix}` }, k)).status).toBe(201)
    const clash = await post(user, '/api/teams', { name: `Route A ${suffix}` }, k)
    expect(clash.status).toBe(409)
    expect(clash.data.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(await testPrisma.team.count({ where: { ownerId: user.userId } })).toBe(0)
  })

  it('creates only once when the same request is sent several times at once', async () => {
    const user = await registerAndLogin(`idk.d.${suffix}@test.dev`, `idkd${suffix}`)
    const k = key()
    const body = { name: `Parallel ${suffix}` }
    const results = await Promise.all(Array.from({ length: 6 }, () => rawPost(user, '/api/projects', body, k)))

    expect(await testPrisma.project.count({ where: { ownerId: user.userId } })).toBe(1)
    expect(results.filter((res) => res.status === 201 && res.headers.get('idempotent-replayed') === null)).toHaveLength(1)
    // The rest were either replays of the finished response or told to retry.
    for (const res of results) {
      expect([201, 409]).toContain(res.status)
      if (res.status === 409) expect(res.data.error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS')
    }
  })

  it('does not replay one person\'s response to another', async () => {
    const a = await registerAndLogin(`idk.e.${suffix}@test.dev`, `idke${suffix}`)
    const b = await registerAndLogin(`idk.f.${suffix}@test.dev`, `idkf${suffix}`)
    const k = key()
    const body = { name: `Shared Key ${suffix}` }
    const first = await post(a, '/api/projects', body, k)
    const second = await post(b, '/api/projects', body, k)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.data.id).not.toBe(first.data.id)
    expect(second.data.ownerId).toBe(b.userId)
  })

  it('lets the client fix a rejected request and retry with the same key', async () => {
    const user = await registerAndLogin(`idk.g.${suffix}@test.dev`, `idkg${suffix}`)
    const k = key()
    const bad = await post(user, '/api/projects', { name: '' }, k)
    expect(bad.status).toBe(400)
    const good = await post(user, '/api/projects', { name: `Fixed ${suffix}` }, k)
    expect(good.status).toBe(201)
  })

  it('rejects a malformed key', async () => {
    const user = await registerAndLogin(`idk.h.${suffix}@test.dev`, `idkh${suffix}`)
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(129)]) {
      const res = await post(user, '/api/projects', { name: `Bad Key ${suffix}` }, bad)
      expect(res.status, bad).toBe(400)
      expect(res.data.error.code).toBe('IDEMPOTENCY_KEY_INVALID')
    }
    expect(await testPrisma.project.count({ where: { ownerId: user.userId } })).toBe(0)
  })

  it('works on the other creating routes too', async () => {
    const user = await registerAndLogin(`idk.i.${suffix}@test.dev`, `idki${suffix}`)
    const team = { path: '/api/teams', body: { name: `Idem Team ${suffix}` } }
    const k1 = key()
    const first = await post(user, team.path, team.body, k1)
    const second = await post(user, team.path, team.body, k1)
    expect(first.status).toBe(201)
    expect(second.data.id).toBe(first.data.id)
    expect(await testPrisma.team.count({ where: { ownerId: user.userId } })).toBe(1)

    const project = (await post(user, '/api/projects', { name: `Idem Host ${suffix}` })).data
    const k2 = key()
    const update = { title: 'Shipped a thing', content: 'details' }
    const u1 = await post(user, `/api/projects/${project.id}/updates`, update, k2)
    const u2 = await post(user, `/api/projects/${project.id}/updates`, update, k2)
    expect(u1.status).toBe(201)
    expect(u2.data.id).toBe(u1.data.id)
    expect(await testPrisma.projectUpdate.count({ where: { projectId: project.id } })).toBe(1)
  })

  it('does nothing special without the header', async () => {
    const user = await registerAndLogin(`idk.j.${suffix}@test.dev`, `idkj${suffix}`)
    const body = { name: `No Key ${suffix}` }
    const a = await post(user, '/api/projects', body)
    const b = await post(user, '/api/projects', body)
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(b.data.id).not.toBe(a.data.id)
  })
})
