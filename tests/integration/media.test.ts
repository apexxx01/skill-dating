import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

// Uploads: declare, PUT to the presigned URL, confirm. The server under test uses the in-memory storage stand-in, whose "bucket" is PUT /api/media/dev-upload/{key}.
describe('media uploads', () => {
  const suffix = uniqueSuffix()
  let alice: TestUser
  let bob: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    alice = await registerAndLogin(`media.alice.${suffix}@test.dev`, `mediaalice${suffix}`)
    bob = await registerAndLogin(`media.bob.${suffix}@test.dev`, `mediabob${suffix}`)
  }, 90_000)
  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 120_000)

  const file = (size = 2048) => {
    const bytes = randomBytes(size)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const declaration = (over: Record<string, unknown> = {}, f = file()) => ({ purpose: 'POST_MEDIA', contentType: 'image/png', bytes: f.bytes.length, width: 800, height: 600, sha256: f.sha256, ...over })

  async function put(user: TestUser, url: string, bytes: Buffer, contentType = 'image/png') {
    return fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${await user.jar.token()}`, 'Content-Type': contentType, 'x-forwarded-for': user.jar.ip }, body: new Uint8Array(bytes) })
  }

  it('needs a signed-in user and a well-formed declaration', async () => {
    expect((await req(null, 'POST', '/api/media/uploads', {})).status).toBe(401)
    expect((await req(null, 'POST', '/api/media/x/complete', {})).status).toBe(401)
    expect((await req(null, 'GET', '/api/media/x')).status).toBe(401)
    for (const body of [{}, declaration({ sha256: 'nope' }), declaration({ purpose: 'AVATAR' }), declaration({ bytes: -5 }), { ...declaration(), extra: 1 }]) {
      const res = await req(alice.jar, 'POST', '/api/media/uploads', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.data.error.code).toBe('VALIDATION_FAILED')
    }
  }, 60_000)

  it('refuses a file that breaks a rule and says which', async () => {
    const f = file()
    const cases: [Record<string, unknown>, string][] = [
      [{ contentType: 'image/svg+xml' }, 'TYPE_NOT_ALLOWED'],
      [{ bytes: 11 * 1024 * 1024 }, 'TOO_LARGE'],
      [{ width: 9000 }, 'DIMENSIONS_OUT_OF_RANGE'],
      [{ contentType: 'video/mp4' }, 'DURATION_REQUIRED'],
      [{ durationMs: 500 }, 'DURATION_NOT_ALLOWED'],
      [{ purpose: 'ROMANCE_PHOTO', contentType: 'image/gif' }, 'PURPOSE_TYPE_MISMATCH'],
      [{ purpose: 'ROMANCE_PHOTO', width: 300, height: 300 }, 'TOO_SMALL'],
    ]
    for (const [over, problem] of cases) {
      const res = await req(alice.jar, 'POST', '/api/media/uploads', declaration(over, f))
      expect(res.status, problem).toBe(400)
      expect(res.data.error.code).toBe('MEDIA_INVALID')
      expect(res.data.error.details.problems.map((p: { problem: string }) => p.problem), problem).toContain(problem)
    }
    expect(await testPrisma.mediaAsset.count({ where: { ownerId: alice.userId } })).toBe(0)
  }, 60_000)

  it('runs the whole flow: declare, PUT, confirm, and the same file again is not uploaded twice', async () => {
    const f = file(4096)
    const declared = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, f))
    expect(declared.status).toBe(201)
    expect(declared.data.duplicate).toBe(false)
    expect(declared.data.asset).toMatchObject({ purpose: 'POST_MEDIA', status: 'PENDING', type: 'IMAGE', width: 800, height: 600 })
    expect(declared.data.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } })
    expect(declared.data.upload.url).toContain(`/api/media/dev-upload/posts/${alice.userId}/${f.sha256}.png`)
    expect(new Date(declared.data.upload.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // Confirming before the upload says so.
    const early = await req(alice.jar, 'POST', `/api/media/${declared.data.asset.id}/complete`, {})
    expect(early.status).toBe(409)
    expect(early.data.error.code).toBe('MEDIA_NOT_UPLOADED')

    const stored = await put(alice, declared.data.upload.url, f.bytes)
    expect(stored.status).toBe(200)
    const done = await req(alice.jar, 'POST', `/api/media/${declared.data.asset.id}/complete`, {})
    expect(done.status).toBe(200)
    expect(done.data).toMatchObject({ id: declared.data.asset.id, status: 'READY', type: 'IMAGE' })
    expect(typeof done.data.url).toBe('string')
    // Repeating the confirmation is fine.
    expect((await req(alice.jar, 'POST', `/api/media/${declared.data.asset.id}/complete`, {})).data.status).toBe('READY')

    // The same file again (even with other, valid, numbers declared): nothing to upload.
    const again = await req(alice.jar, 'POST', '/api/media/uploads', declaration({ width: 640, height: 480 }, f))
    expect(again.status).toBe(200)
    expect(again.data).toMatchObject({ duplicate: true, upload: null })
    expect(again.data.asset.id).toBe(declared.data.asset.id)
    expect(await testPrisma.mediaAsset.count({ where: { ownerId: alice.userId, sha256: f.sha256 } })).toBe(1)

    // Somebody else uploading the same bytes has an asset of their own.
    const other = await req(bob.jar, 'POST', '/api/media/uploads', declaration({}, f))
    expect(other.status).toBe(201)
    expect(other.data.asset.id).not.toBe(declared.data.asset.id)

    const read = await req(alice.jar, 'GET', `/api/media/${declared.data.asset.id}`)
    expect(read.data).toMatchObject({ status: 'READY', type: 'IMAGE' })
  }, 60_000)

  it('rejects an upload that is not what was declared, deletes it, and lets the person try again', async () => {
    const f = file(3000)
    const declared = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, f))
    const smaller = Buffer.from(f.bytes.subarray(0, 1000))
    expect((await put(alice, declared.data.upload.url, smaller)).status).toBe(200)
    const bad = await req(alice.jar, 'POST', `/api/media/${declared.data.asset.id}/complete`, {})
    expect(bad.status).toBe(422)
    expect(bad.data.error.code).toBe('MEDIA_MISMATCH')
    expect(bad.data.error.details).toMatchObject({ declared: { bytes: 3000 }, found: { bytes: 1000 } })
    expect((await testPrisma.mediaAsset.findUniqueOrThrow({ where: { id: declared.data.asset.id } })).status).toBe('REJECTED')

    // Another type than declared is the same.
    const g = file(500)
    const declaredPng = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, g))
    await put(alice, declaredPng.data.upload.url, g.bytes, 'image/jpeg')
    expect((await req(alice.jar, 'POST', `/api/media/${declaredPng.data.asset.id}/complete`, {})).data.error.code).toBe('MEDIA_MISMATCH')

    // A rejected file can be declared and uploaded again.
    const retry = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, f))
    expect(retry.status).toBe(201)
    expect(retry.data.asset.id).toBe(declared.data.asset.id)
    await put(alice, retry.data.upload.url, f.bytes)
    expect((await req(alice.jar, 'POST', `/api/media/${declared.data.asset.id}/complete`, {})).data.status).toBe('READY')
  }, 60_000)

  it('keeps one person\'s uploads from another', async () => {
    const f = file()
    const declared = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, f))
    for (const [method, path] of [['GET', `/api/media/${declared.data.asset.id}`], ['POST', `/api/media/${declared.data.asset.id}/complete`]] as const) {
      const res = await req(bob.jar, method, path, method === 'POST' ? {} : undefined)
      expect(res.status, path).toBe(404)
      expect(res.data.error.code).toBe('MEDIA_NOT_FOUND')
    }
    // The development bucket takes only the caller's own keys, and only an allowed type.
    expect((await put(bob, declared.data.upload.url, f.bytes)).status).toBe(403)
    expect((await put(alice, declared.data.upload.url, f.bytes, 'text/html')).status).toBe(400)
  }, 60_000)

  it('limits unfinished uploads', async () => {
    const carol = await registerAndLogin(`media.carol.${suffix}@test.dev`, `mediacarol${suffix}`)
    await testPrisma.mediaAsset.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        ownerId: carol.userId, purpose: 'POST_MEDIA' as const, kind: 'IMAGE' as const, key: `posts/${carol.userId}/pending-${i}.png`, contentType: 'image/png', bytes: 10, width: 100, height: 100, sha256: `${i}`.padStart(64, 'a'),
      })),
    })
    const res = await req(carol.jar, 'POST', '/api/media/uploads', declaration())
    expect(res.status).toBe(429)
    expect(res.data.error.code).toBe('MEDIA_PENDING_LIMIT')
  }, 60_000)

  it('honours an Idempotency-Key: a repeated declaration is the same answer', async () => {
    const f = file()
    const key = `media-${suffix}-idem-0001`
    const first = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, f), { 'Idempotency-Key': key })
    const second = await req(alice.jar, 'POST', '/api/media/uploads', declaration({}, f), { 'Idempotency-Key': key })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.data.asset.id).toBe(first.data.asset.id)
  }, 60_000)

  it('cleans up uploads nobody finished', async () => {
    const { cleanupAbandonedUploads } = await import('../../src/lib/media-assets')
    const { MemoryStorage } = await import('../../src/lib/infra/storage.memory')
    const storage = new MemoryStorage()
    const old = await testPrisma.mediaAsset.create({
      data: { ownerId: alice.userId, purpose: 'POST_MEDIA', kind: 'IMAGE', key: `posts/${alice.userId}/old.png`, contentType: 'image/png', bytes: 10, width: 100, height: 100, sha256: 'b'.repeat(64), createdAt: new Date(Date.now() - 30 * 3_600_000) },
    })
    const fresh = await testPrisma.mediaAsset.create({
      data: { ownerId: alice.userId, purpose: 'POST_MEDIA', kind: 'IMAGE', key: `posts/${alice.userId}/fresh.png`, contentType: 'image/png', bytes: 10, width: 100, height: 100, sha256: 'c'.repeat(64) },
    })
    const ready = await testPrisma.mediaAsset.create({
      data: { ownerId: alice.userId, purpose: 'POST_MEDIA', kind: 'IMAGE', key: `posts/${alice.userId}/ready.png`, contentType: 'image/png', bytes: 10, width: 100, height: 100, sha256: 'd'.repeat(64), status: 'READY', createdAt: new Date(Date.now() - 90 * 3_600_000) },
    })
    const result = await cleanupAbandonedUploads(testPrisma, storage)
    expect(result.removed).toBeGreaterThanOrEqual(1)
    expect(await testPrisma.mediaAsset.findUnique({ where: { id: old.id } })).toBeNull()
    expect(await testPrisma.mediaAsset.findUnique({ where: { id: fresh.id } })).not.toBeNull()
    expect(await testPrisma.mediaAsset.findUnique({ where: { id: ready.id } })).not.toBeNull()
  }, 60_000)
})
