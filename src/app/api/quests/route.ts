import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { loadQuests } from '@/lib/quest-view'

// The caller's current quests: three daily and three weekly, each with its progress and when it resets
// (the first instant of the next local day or week in their time zone). Completing a quest is not a call
// you make: doing the thing counts, and the response of that action says `questsCompleted` in its rewards.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { timezone: true } })
  return createApiResponse(await loadQuests(prisma, user.id, row?.timezone))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'quests:get' } })
