import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import type { MemoryStorage } from '@/lib/infra/storage.memory'
import { ALLOWED_CONTENT_TYPES } from '@/lib/media'

// PUT /api/media/dev-upload/{key}: the "bucket" of the in-memory storage stand-in, so that uploads work end to end in development and in the integration tests.
// It exists ONLY while the stand-in is the storage in use (no STORAGE_* settings and not production); with a real bucket, or in production, it is "not found". The
// bytes are not kept, only their size and type, which is all the confirmation step reads. The key must belong to the caller.
const MAX_BYTES = 100 * 1024 * 1024

export const PUT = withAuth(async (request: NextRequest, { user }) => {
  // By kind, not by class: Next bundles each route on its own, so the class of another route's instance is not this file's.
  const storage = getStorage()
  if (storage.kind !== 'memory') return createApiError('MEDIA_NOT_FOUND')

  const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/api\/media\/dev-upload\//, ''))
  const [, owner] = key.split('/')
  if (owner !== user.id) return createApiError('FORBIDDEN')

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_CONTENT_TYPES[contentType]) return createApiError('MEDIA_INVALID', { details: { problems: [{ problem: 'TYPE_NOT_ALLOWED' }] } })
  const bytes = (await request.arrayBuffer()).byteLength
  if (bytes > MAX_BYTES) return createApiError('PAYLOAD_TOO_LARGE')
  ;(storage as MemoryStorage).simulateUpload(key, { size: bytes, contentType })
  return createApiResponse({ stored: true, bytes })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'media:dev-upload' } })
