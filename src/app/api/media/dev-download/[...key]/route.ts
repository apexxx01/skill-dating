import { NextRequest, NextResponse } from 'next/server'
import { withAuth, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import type { MemoryStorage } from '@/lib/infra/storage.memory'

// GET /api/media/dev-download/{key}: reads an object the server wrote (a data export) from the in-memory storage stand-in, so the export works end to end
// in development and in the integration tests. Like dev-upload, it exists ONLY while the stand-in is the storage in use (with a real bucket the signed
// URL points at the bucket and this answers "not found"), and the key must belong to the caller.
export const GET = withAuth(async (request: NextRequest, { user }) => {
  const storage = getStorage()
  if (storage.kind !== 'memory') return createApiError('MEDIA_NOT_FOUND')
  const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/api\/media\/dev-download\//, ''))
  const [, owner] = key.split('/')
  if (owner !== user.id) return createApiError('FORBIDDEN')
  const bytes = (storage as MemoryStorage).contents.get(key)
  const info = await storage.head(key)
  if (!bytes || !info) return createApiError('MEDIA_NOT_FOUND')
  return new NextResponse(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': info.contentType ?? 'application/octet-stream', 'Cache-Control': 'no-store' } })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'media:dev-download' } })
