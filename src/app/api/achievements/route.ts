import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { loadAchievementItems } from '@/lib/achievement-catalog'
import type { AchievementsResponse } from '@/types/api'

// The whole achievement catalog with the caller's standing in each (earned, when, progress toward the
// target, rarity). About forty entries, so it is one list with no paging. Secret achievements stay
// masked until the caller earns them.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const achievements = await loadAchievementItems(prisma, user.id)
  return createApiResponse<AchievementsResponse>({ achievements, earned: achievements.filter((item) => item.earned).length, total: achievements.length })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'achievements:list' } })
