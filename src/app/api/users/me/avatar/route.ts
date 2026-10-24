import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { readyAssets } from '@/lib/media-assets'
import { bodySchema } from './schema'

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
