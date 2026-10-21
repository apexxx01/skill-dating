import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryStorage } from './storage.memory'
import { S3Storage, StorageUnavailableError, UnavailableStorage, createStorage } from './storage'
import { resetEnvCache } from '@/lib/env'

const config = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'skill-dating', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'SECRET' }
const now = new Date('2026-10-18T10:00:00Z')

describe('S3Storage', () => {
  it('presigns a PUT for exactly one key and content type, with the type signed', async () => {
    const storage = new S3Storage(config, undefined, () => now)
    const upload = await storage.presignUpload({ key: 'posts/u1/abc.png', contentType: 'image/png', ttlSeconds: 600 })
    const url = new URL(upload.url)
    expect(url.host).toBe('acct.r2.cloudflarestorage.com')
    expect(url.pathname).toBe('/skill-dating/posts/u1/abc.png')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png' })
    expect(upload.expiresAt.toISOString()).toBe('2026-10-18T10:10:00.000Z')
    expect(upload.method).toBe('PUT')
  })

  it('never puts the secret in a URL', async () => {
    const storage = new S3Storage(config, undefined, () => now)
    const upload = await storage.presignUpload({ key: 'k.png', contentType: 'image/png' })
    expect(upload.url).not.toContain('SECRET')
    expect(await storage.signedReadUrl('k.png')).not.toContain('SECRET')
  })

  it('signs reads for a short time and encodes the key', async () => {
    const storage = new S3Storage(config, undefined, () => now)
    const url = new URL(await storage.signedReadUrl('romance/u 1/a+b.jpg', 900))
    expect(url.pathname).toBe('/skill-dating/romance/u%201/a%2Bb.jpg')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
  })

  it('reads an object with a signed HEAD', async () => {
    const calls: { url: string; method?: string }[] = []
    const fetcher = vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method })
      return { ok: true, status: 200, headers: new Headers({ 'content-length': '1234', 'content-type': 'image/png' }) }
    })
    const storage = new S3Storage(config, fetcher, () => now)
    expect(await storage.head('posts/u1/abc.png')).toEqual({ size: 1234, contentType: 'image/png' })
    expect(calls[0].method).toBe('HEAD')
    expect(new URL(calls[0].url).searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('treats a missing object as null and a server error as an error', async () => {
    const missing = new S3Storage(config, async () => ({ ok: false, status: 404, headers: new Headers() }), () => now)
    expect(await missing.head('nothing')).toBeNull()
    const broken = new S3Storage(config, async () => ({ ok: false, status: 500, headers: new Headers() }), () => now)
    await expect(broken.head('x')).rejects.toThrow('500')
  })

  it('deletes with a signed DELETE and does not mind an object that is already gone', async () => {
    const statuses = [204, 404]
    const fetcher = vi.fn(async () => ({ ok: statuses[0] === 204, status: statuses.shift()!, headers: new Headers() }))
    const storage = new S3Storage(config, fetcher, () => now)
    await storage.remove('a')
    await storage.remove('a')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('gives a permanent URL only when a public base is configured', () => {
    expect(new S3Storage(config).publicUrl('posts/a b.png')).toBeNull()
    expect(new S3Storage({ ...config, publicBaseUrl: 'https://cdn.example.com/' }).publicUrl('posts/a b.png')).toBe('https://cdn.example.com/posts/a%20b.png')
  })
})

describe('UnavailableStorage', () => {
  it('refuses everything, loudly', async () => {
    const storage = new UnavailableStorage()
    await expect(storage.presignUpload()).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(storage.head()).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(storage.signedReadUrl()).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(storage.remove()).rejects.toBeInstanceOf(StorageUnavailableError)
    expect(storage.publicUrl()).toBeNull()
  })
})

describe('MemoryStorage', () => {
  it('stands in for a bucket: head sees only what an upload was simulated for', async () => {
    const storage = new MemoryStorage(() => now)
    const upload = await storage.presignUpload({ key: 'posts/u/x.png', contentType: 'image/png' })
    expect(upload.url).toBe('memory://upload/posts/u/x.png')
    expect(await storage.head('posts/u/x.png')).toBeNull()
    storage.simulateUpload('posts/u/x.png', { size: 10, contentType: 'image/png' })
    expect(await storage.head('posts/u/x.png')).toEqual({ size: 10, contentType: 'image/png' })
    await storage.remove('posts/u/x.png')
    expect(await storage.head('posts/u/x.png')).toBeNull()
  })
})

describe('createStorage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  function storageFor(vars: Record<string, string>) {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value)
    resetEnvCache()
    return createStorage()
  }

  it('refuses uploads in a production build without a bucket', () => {
    expect(storageFor({ NODE_ENV: 'production', VERCEL_ENV: 'preview' }).kind).toBe('unavailable')
  })

  it('keeps uploads in memory for the integration suite running a production build', () => {
    expect(storageFor({ NODE_ENV: 'production', VERCEL_ENV: 'preview', INTEGRATION_TEST_SERVER: 'true' }).kind).toBe('memory')
  })

  it('keeps uploads in memory in development', () => {
    expect(storageFor({ NODE_ENV: 'development' }).kind).toBe('memory')
  })
})
