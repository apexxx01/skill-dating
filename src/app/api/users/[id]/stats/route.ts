import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockRelation } from '@/lib/blocks'
import { forViewer, loadPlayerCard } from '@/lib/player-card'
import { isValidId } from '@/lib/progress'

// GET /api/users/{id}/stats: the player card, in one call. Cached for 60 seconds and refreshed by every award.
// Somebody who has blocked the viewer, or is gone, looks like a user that does not exist. A person who keeps
// their activity private shows no streak to anyone else.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/')[3]
  if (!isValidId(id)) return createApiError('USER_NOT_FOUND')
  if ((await blockRelation(prisma, user.id, id)) === 'BLOCKED_BY_THEM') return createApiError('USER_NOT_FOUND')

  const card = await loadPlayerCard(prisma, id)
  if (!card) return createApiError('USER_NOT_FOUND')

  const profile = id === user.id ? null : await prisma.profile.findUnique({ where: { userId: id }, select: { showActivity: true } })
  return createApiResponse(forViewer(card, { isOwner: id === user.id, showActivity: profile?.showActivity ?? true }))
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:stats' } })
