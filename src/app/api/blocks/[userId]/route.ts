import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'

// Removes the caller's own block on :userId. It can only ever match a row
// whose blockerId is the caller, so it cannot lift a block someone else
// placed, and it never reveals whether the other user has blocked the caller.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const targetId = new URL(request.url).pathname.split('/').pop()

  if (!targetId) {
    return createApiError('User ID required', 400)
  }

  const result = await prisma.block.deleteMany({
    where: { blockerId: user.id, blockedId: targetId },
  })

  return createApiResponse({ success: true, unblocked: result.count > 0 })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'blocks:delete' } })
