import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { loadAchievementItems } from '@/lib/achievement-catalog'
import { blockRelation } from '@/lib/blocks'
import { isValidId } from '@/lib/progress'
import type { AchievementsResponse } from '@/types/api'

// The catalog from one person's point of view: what they have earned and how far along they are in the
// rest. Same shape as GET /api/achievements. A secret achievement they have not earned is masked for
// everybody, the owner included. Somebody who has blocked the viewer (or is gone) looks like a user that
// does not exist; the person who did the blocking can still open it, as with the profile.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/')[3]
  if (!isValidId(id)) return createApiError('USER_NOT_FOUND')

  const owner = await prisma.user.findUnique({ where: { id }, select: { deletedAt: true } })
  if (!owner || owner.deletedAt) return createApiError('USER_NOT_FOUND')
  if ((await blockRelation(prisma, user.id, id)) === 'BLOCKED_BY_THEM') return createApiError('USER_NOT_FOUND')

  const achievements = await loadAchievementItems(prisma, id)
  return createApiResponse<AchievementsResponse>({ achievements, earned: achievements.filter((item) => item.earned).length, total: achievements.length })
}, { cache: { maxAge: 60 }, rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:achievements' } })
