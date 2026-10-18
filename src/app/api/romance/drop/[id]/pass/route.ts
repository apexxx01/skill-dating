import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'

// Passes on the week's romance drop: the person is not shown to the caller again for 120 days. Passing twice answers the same. Anyone else's drop is "not found".
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const drop = await prisma.romanceDrop.findUnique({ where: { id }, select: { id: true, userId: true, status: true } })
  if (!drop || drop.userId !== user.id) return createApiError('DROP_NOT_FOUND')
  if (drop.status === 'PASSED') return createApiResponse({ id, status: 'PASSED' })
  if (drop.status !== 'NEW') return createApiError('DROP_NOT_PENDING')
  // Only while it is still open: a spark that landed in the meantime wins.
  const changed = await prisma.romanceDrop.updateMany({ where: { id, userId: user.id, status: 'NEW' }, data: { status: 'PASSED' } })
  if (changed.count === 0) return createApiError('DROP_NOT_PENDING')
  return createApiResponse({ id, status: 'PASSED' })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'romance:drop-pass' } })
