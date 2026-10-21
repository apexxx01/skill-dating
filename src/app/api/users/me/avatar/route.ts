import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { readyAssets } from '@/lib/media-assets'

// PUT /api/users/me/avatar { mediaId }: uses an uploaded AVATAR (POST /api/media/uploads with purpose AVATAR, then complete) as the profile picture.
// Only a READY asset can be used, which for an avatar means the media scanner passed it (or a moderator approved it); while it is SCANNING or IN_REVIEW
// it is "not found". The picture is served from the bucket's public address, so this needs STORAGE_PUBLIC_BASE_URL (503 STORAGE_UNAVAILABLE without).
// DELETE removes the picture.
const bodySchema = z.object({ mediaId: z.string().min(1).max(64) }).strict()

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const [asset] = await readyAssets(prisma, user.id, 'AVATAR', [body.data.mediaId])
  if (!asset) return createApiError('MEDIA_NOT_FOUND')
  const url = getStorage().publicUrl(asset.key)
  if (!url) return createApiError('STORAGE_UNAVAILABLE')
  await prisma.user.update({ where: { id: user.id }, data: { image: url } })
  return createApiResponse({ image: url })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'users:me:avatar-set' } })

export const DELETE = withAuth(async (_request: NextRequest, { prisma, user }) => {
  await prisma.user.update({ where: { id: user.id }, data: { image: null } })
  return createApiResponse({ image: null })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'users:me:avatar-delete' } })
