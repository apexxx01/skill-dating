import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { toMediaView } from '@/lib/media-assets'

// GET /api/media/{id}: one of the caller's own uploads and where it stands. Somebody else's is "not found".
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const asset = await prisma.mediaAsset.findUnique({ where: { id } })
  if (!asset || asset.ownerId !== user.id) return createApiError('MEDIA_NOT_FOUND')
  const view = asset.status === 'READY' ? await toMediaView(getStorage(), asset).catch(() => null) : null
  return createApiResponse({ id: asset.id, purpose: asset.purpose, status: asset.status, type: asset.kind, width: asset.width, height: asset.height, durationMs: asset.durationMs, ...(view ? { url: view.url } : {}) })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'media:get' } })
