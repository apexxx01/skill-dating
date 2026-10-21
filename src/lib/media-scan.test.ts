import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/moderation/reports', () => ({ fileAutomatedReport: vi.fn(async () => ({ id: 'r1' })) }))
vi.mock('@/lib/infra/jobs', () => ({ getJobQueue: () => ({ enqueue: vi.fn(async () => undefined) }) }))

import { scanAsset } from './media-assets'
import { fileAutomatedReport } from '@/lib/moderation/reports'
import { MemoryStorage } from '@/lib/infra/storage.memory'
import { HttpScanner, NoopScanner, UnavailableScanner, type MediaScanner } from '@/lib/infra/media-moderation'

const now = new Date('2026-10-20T00:00:00Z')
const asset = { id: 'a1', ownerId: 'u1', purpose: 'ROMANCE_PHOTO', key: 'romance/u1/x.jpg', contentType: 'image/jpeg', sha256: 'f'.repeat(64), status: 'SCANNING' } as never

function fakeDb() {
  return { mediaAsset: { update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...(asset as object), ...data })) } }
}
const scanner = (verdict: 'SAFE' | 'NEEDS_REVIEW' | 'BLOCKED', labels: string[] = []): MediaScanner => ({ kind: 'http', available: true, scan: async () => ({ verdict, labels }) })

beforeEach(() => {
  vi.mocked(fileAutomatedReport).mockClear()
})

describe('scanAsset', () => {
  it('serves a SAFE photo', async () => {
    const db = fakeDb()
    const result = await scanAsset(db as never, new MemoryStorage(), asset, now, scanner('SAFE'))
    expect(result).toMatchObject({ status: 'READY', scanVerdict: 'SAFE' })
    expect(fileAutomatedReport).not.toHaveBeenCalled()
  })

  it('holds a photo the scanner is unsure about, and files a report for a moderator', async () => {
    const result = await scanAsset(fakeDb() as never, new MemoryStorage(), asset, now, scanner('NEEDS_REVIEW', ['suggestive']))
    expect(result).toMatchObject({ status: 'IN_REVIEW', scanLabels: ['suggestive'] })
    expect(fileAutomatedReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetType: 'MEDIA', targetId: 'a1', reason: 'INAPPROPRIATE_CONTENT' }))
  })

  it('deletes a BLOCKED photo at once, keeping only the hash and the verdict, and raises a child-safety label to the top', async () => {
    const storage = new MemoryStorage()
    await storage.put('romance/u1/x.jpg', 'bytes', 'image/jpeg')
    const result = await scanAsset(fakeDb() as never, storage, asset, now, scanner('BLOCKED', ['csam-match']))
    expect(result).toMatchObject({ status: 'BLOCKED', scanVerdict: 'BLOCKED' })
    expect(storage.contents.has('romance/u1/x.jpg')).toBe(false)
    expect(fileAutomatedReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'MINOR_SAFETY' }))
  })

  it('keeps the photo unserved when the scanner fails, to try again', async () => {
    const failing: MediaScanner = { kind: 'http', available: true, scan: async () => { throw new Error('down') } }
    const db = fakeDb()
    expect((await scanAsset(db as never, new MemoryStorage(), asset, now, failing)).status).toBe('SCANNING')
    expect(db.mediaAsset.update).not.toHaveBeenCalled()
  })
})

describe('scanners', () => {
  it('treats everything as SAFE in development, and fails closed when unavailable', async () => {
    expect(await new NoopScanner().scan()).toEqual({ verdict: 'SAFE', labels: [] })
    expect(new UnavailableScanner().available).toBe(false)
    await expect(new UnavailableScanner().scan()).rejects.toThrow()
  })

  it('reads a provider’s answer, and treats an unknown verdict as needing review', async () => {
    const ok = new HttpScanner('https://scan.example/v1', 'token', async () => ({ ok: true, status: 200, json: async () => ({ verdict: 'BLOCKED', labels: ['nudity', 42] }) }))
    expect(await ok.scan({ url: 'https://x', contentType: 'image/jpeg', sha256: 'f' })).toEqual({ verdict: 'BLOCKED', labels: ['nudity'] })
    const odd = new HttpScanner('https://scan.example/v1', 'token', async () => ({ ok: true, status: 200, json: async () => ({ verdict: 'MAYBE' }) }))
    expect((await odd.scan({ url: 'https://x', contentType: 'image/jpeg', sha256: 'f' })).verdict).toBe('NEEDS_REVIEW')
    const down = new HttpScanner('https://scan.example/v1', 'token', async () => ({ ok: false, status: 500, json: async () => ({}) }))
    await expect(down.scan({ url: 'https://x', contentType: 'image/jpeg', sha256: 'f' })).rejects.toThrow()
  })
})
