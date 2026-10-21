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
  const asset = result.asset
  // A file that is still being scanned or reviewed (profile photos of either kind) is never served: no URL until it is READY.
  const url = asset.status === 'READY' ? (await toMediaView(getStorage(), asset)).url : null
  return createApiResponse({ id: asset.id, purpose: asset.purpose, status: asset.status, type: asset.kind, width: asset.width, height: asset.height, durationMs: asset.durationMs, url })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'media:complete' } })
