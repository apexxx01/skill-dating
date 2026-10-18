import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { addPhoto, addPhotoSchema } from '@/lib/romance/photos'

// Attaches a confirmed upload (POST /api/media/uploads with purpose ROMANCE_PHOTO, then /complete) to the caller's romance profile, at the end of their photos. `blurHash` is optional: a
// BlurHash the client made, shown in place of the photo to anyone who may not see it yet. At most 6 photos. Photos come back to their owner only (GET /api/romance/profile).
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(addPhotoSchema)(request)
  if (body instanceof Response) return body
  const result = await addPhoto(prisma, user.id, body.data)
  if (!result.ok) return createApiError(result.code, { details: result.details })
  return createApiResponse({ id: result.id, position: result.position }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:photo-add' } })
