import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { passDrop } from '@/lib/matching/drop-view'

// Passes on a drop: this person is not shown to the caller again for 30 days. Passing twice is fine. A drop that is not the caller's is
// 404, one already sparked or expired is 409.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const outcome = await passDrop(prisma, user.id, id)
  if (outcome === 'NOT_FOUND') return createApiError('DROP_NOT_FOUND')
  if (outcome === 'NOT_PENDING') return createApiError('DROP_NOT_PENDING')
  return createApiResponse({ id, status: 'PASSED' as const })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'drops:pass' } })
