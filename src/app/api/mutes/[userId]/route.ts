import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'

// DELETE /api/mutes/{userId}: unmute. Idempotent.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const userId = new URL(request.url).pathname.split('/').pop()!
  await prisma.mute.deleteMany({ where: { muterId: user.id, mutedId: userId } })
  return createApiResponse({ muted: false, userId })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'mutes:delete' } })
