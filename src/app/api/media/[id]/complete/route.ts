import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { completeUpload, toMediaView } from '@/lib/media-assets'

// POST /api/media/{id}/complete: after the PUT. The server looks at the real object and compares its size and type with what was declared: a match makes the asset
// READY (usable in a post or as a photo); a mismatch rejects it and deletes the object (`422 MEDIA_MISMATCH`). Safe to repeat.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const result = await completeUpload(prisma, getStorage(), user.id, id)
  if (!result.ok) return createApiError(result.code, { details: result.details })
  const view = await toMediaView(getStorage(), result.asset)
  return createApiResponse({ id: result.asset.id, purpose: result.asset.purpose, status: result.asset.status, type: view.type, width: view.width, height: view.height, durationMs: view.durationMs, url: view.url })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'media:complete' } })
