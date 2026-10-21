import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { accountState } from '@/lib/moderation/restrictions'

// GET /api/users/me/moderation: what moderation did about the caller, for the account page and the appeal form: the actions (category, the note to them,
// until when, whether and until when they can appeal, any appeal) and what is restricted now. Never who reported them or the moderator's own notes.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const [actions, state] = await Promise.all([
    prisma.moderationAction.findMany({
      where: { subjectUserId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, targetType: true, targetId: true, metadata: true, noteToUser: true, feature: true, expiresAt: true, appealableUntil: true, reversedAt: true, createdAt: true, appeal: { select: { id: true, status: true } } },
    }),
    accountState(prisma, user.id),
  ])
  const now = Date.now()
  return createApiResponse({
    state,
    actions: actions.map(({ metadata, appealableUntil, ...action }) => ({
      ...action,
      category: (metadata as { category?: string } | null)?.category ?? null,
      appealableUntil,
      canAppeal: !action.appeal && !action.reversedAt && appealableUntil !== null && appealableUntil.getTime() > now,
    })),
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:me:moderation' } })
