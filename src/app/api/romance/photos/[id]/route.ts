import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { removePhoto } from '@/lib/romance/photos'

// Removes one of the caller's photos and its upload. Somebody else's is "not found".
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  if (!(await removePhoto(prisma, getStorage(), user.id, id))) return createApiError('MEDIA_NOT_FOUND')
  return createApiResponse({ removed: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'romance:photo-remove' } })
