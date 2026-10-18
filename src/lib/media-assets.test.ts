import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { MemoryStorage } from './infra/storage.memory'
import { UnavailableStorage } from './infra/storage'
import { completeUpload, readyAssets, requestUpload } from './media-assets'
import type { MediaDeclaration } from './media'

const sha = 'a'.repeat(64)
const declaration = (over: Partial<MediaDeclaration> = {}): MediaDeclaration => ({ purpose: 'POST_MEDIA', contentType: 'image/png', bytes: 100, width: 640, height: 480, sha256: sha, ...over })

function fakeDb(rows: Record<string, unknown>[] = []) {
  const table = rows
  return {
    table,
    db: {
      mediaAsset: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id) return table.find((row) => row.id === where.id) ?? null
          const key = where.ownerId_purpose_sha256 as { ownerId: string; purpose: string; sha256: string }
          return table.find((row) => row.ownerId === key.ownerId && row.purpose === key.purpose && row.sha256 === key.sha256) ?? null
        }),
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; ownerId: string; purpose: string; status: string } }) =>
          table.filter((row) => where.id.in.includes(row.id as string) && row.ownerId === where.ownerId && row.purpose === where.purpose && row.status === where.status)
        ),
        count: vi.fn(async () => table.filter((row) => row.status === 'PENDING').length),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `m${table.length + 1}`, status: 'PENDING', confirmedAt: null, ...data }
          table.push(row)
          return row
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = table.find((entry) => entry.id === where.id)!
          Object.assign(row, data)
          return row
        }),
      },
    } as unknown as PrismaClient,
  }
}

describe('requestUpload', () => {
  it('refuses a declaration before anything is written or signed', async () => {
    const { db, table } = fakeDb()
    const result = await requestUpload(db, new MemoryStorage(), 'u1', declaration({ contentType: 'application/zip' }))
    expect(result).toMatchObject({ ok: false, code: 'MEDIA_INVALID' })
    expect(table).toEqual([])
  })

  it('makes a pending asset under a content-addressed key and signs an upload for exactly that', async () => {
    const { db, table } = fakeDb()
    const result = await requestUpload(db, new MemoryStorage(), 'u1', declaration(), { origin: 'http://localhost:3000' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.duplicate).toBe(false)
    expect(table[0]).toMatchObject({ ownerId: 'u1', key: `posts/u1/${sha}.png`, status: 'PENDING', kind: 'IMAGE' })
    expect(result.upload?.url).toBe(`http://localhost:3000/api/media/dev-upload/posts/u1/${sha}.png`)
    expect(result.upload?.headers).toEqual({ 'Content-Type': 'image/png' })
  })

  it('does not sign anything for a file that is already there and checked', async () => {
    const { db } = fakeDb([{ id: 'm1', ownerId: 'u1', purpose: 'POST_MEDIA', sha256: sha, status: 'READY', key: `posts/u1/${sha}.png` }])
    const result = await requestUpload(db, new MemoryStorage(), 'u1', declaration())
    expect(result).toMatchObject({ ok: true, duplicate: true, upload: null })
  })

  it('answers with a refusal, not a crash, when storage is not configured', async () => {
    const { db } = fakeDb()
    expect(await requestUpload(db, new UnavailableStorage(), 'u1', declaration())).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' })
  })

  it('stops a person who has too many unfinished uploads', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, ownerId: 'u1', purpose: 'POST_MEDIA', sha256: `${i}`, status: 'PENDING' }))
    const { db } = fakeDb(rows)
    expect(await requestUpload(db, new MemoryStorage(), 'u1', declaration())).toMatchObject({ ok: false, code: 'MEDIA_PENDING_LIMIT' })
  })
})

describe('completeUpload', () => {
  const pending = { id: 'm1', ownerId: 'u1', purpose: 'POST_MEDIA', kind: 'IMAGE', sha256: sha, status: 'PENDING', key: 'posts/u1/x.png', contentType: 'image/png', bytes: 100, width: 640, height: 480, durationMs: null }

  it('makes the asset ready when the object is what was declared', async () => {
    const { db, table } = fakeDb([{ ...pending }])
    const storage = new MemoryStorage()
    storage.simulateUpload('posts/u1/x.png', { size: 100, contentType: 'image/png' })
    const result = await completeUpload(db, storage, 'u1', 'm1')
    expect(result.ok).toBe(true)
    expect(table[0].status).toBe('READY')
  })

  it('says so when nothing was uploaded, and keeps the asset pending', async () => {
    const { db, table } = fakeDb([{ ...pending }])
    expect(await completeUpload(db, new MemoryStorage(), 'u1', 'm1')).toMatchObject({ ok: false, code: 'MEDIA_NOT_UPLOADED' })
    expect(table[0].status).toBe('PENDING')
  })

  it('rejects a file of another size or type and deletes the object', async () => {
    const { db, table } = fakeDb([{ ...pending }])
    const storage = new MemoryStorage()
    storage.simulateUpload('posts/u1/x.png', { size: 101, contentType: 'image/png' })
    expect(await completeUpload(db, storage, 'u1', 'm1')).toMatchObject({ ok: false, code: 'MEDIA_MISMATCH' })
    expect(table[0].status).toBe('REJECTED')
    expect(await storage.head('posts/u1/x.png')).toBeNull()
  })

  it('treats somebody else\'s asset as not found', async () => {
    const { db } = fakeDb([{ ...pending }])
    expect(await completeUpload(db, new MemoryStorage(), 'u2', 'm1')).toMatchObject({ ok: false, code: 'MEDIA_NOT_FOUND' })
  })
})

describe('readyAssets', () => {
  it('returns only the caller\'s ready assets of the purpose, in the order asked', async () => {
    const rows = [
      { id: 'a', ownerId: 'u1', purpose: 'POST_MEDIA', status: 'READY' },
      { id: 'b', ownerId: 'u1', purpose: 'POST_MEDIA', status: 'PENDING' },
      { id: 'c', ownerId: 'u2', purpose: 'POST_MEDIA', status: 'READY' },
      { id: 'd', ownerId: 'u1', purpose: 'ROMANCE_PHOTO', status: 'READY' },
      { id: 'e', ownerId: 'u1', purpose: 'POST_MEDIA', status: 'READY' },
    ]
    const { db } = fakeDb(rows)
    expect((await readyAssets(db, 'u1', 'POST_MEDIA', ['e', 'b', 'c', 'd', 'a', 'zzz'])).map((row) => row.id)).toEqual(['e', 'a'])
    expect(await readyAssets(db, 'u1', 'POST_MEDIA', [])).toEqual([])
  })
})
