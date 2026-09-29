import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import {
  isValidEmoji,
  reactionSummary,
  MAX_DISTINCT_EMOJI_PER_MESSAGE,
  MAX_DISTINCT_EMOJI_PER_USER_PER_MESSAGE,
} from '@/lib/messaging'
import { z } from 'zod'

const reactSchema = z.object({
  emoji: z.string().min(1).max(16).refine(isValidEmoji, 'Must be a single emoji'),
})

function messageIdFrom(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/').slice(-2)[0]
}

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = messageIdFrom(request)
  if (!id) return createApiError('Message ID required', 400)

  const message = await prisma.message.findUnique({ where: { id }, select: { conversationId: true } })
  if (!message) return createApiError('Message not found', 404)

  if (!(await checkMembership(prisma, user.id, 'conversation', message.conversationId))) {
    return createApiError('Forbidden', 403)
  }

  return createApiResponse({ messageId: id, reactions: await reactionSummary(prisma, id, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'messaging:reactions:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = messageIdFrom(request)
  if (!id) return createApiError('Message ID required', 400)

  const message = await prisma.message.findUnique({
    where: { id },
    select: { conversationId: true, deletedAt: true },
  })
  if (!message) return createApiError('Message not found', 404)

  if (!(await checkMembership(prisma, user.id, 'conversation', message.conversationId))) {
    return createApiError('Forbidden', 403)
  }
  if (message.deletedAt) return createApiError('Cannot react to a deleted message', 400)

  const bodyResult = await validateBody(reactSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { emoji } = bodyResult.data


  // Toggle. deleteMany returns 0 rows when nothing was there, which avoids
  // an error if a parallel request already removed it; a parallel create that
  // loses the race hits the unique constraint (P2002) and is treated as "the
  // reaction now exists", so concurrent toggles never surface a 500.
  const removed = await prisma.messageReaction.deleteMany({ where: { messageId: id, userId: user.id, emoji } })
  let reacted = false

  if (removed.count === 0) {
    const [mine, distinct] = await Promise.all([
      prisma.messageReaction.count({ where: { messageId: id, userId: user.id } }),
      prisma.messageReaction.groupBy({ by: ['emoji'], where: { messageId: id }, _count: { _all: true } }),
    ])
    if (mine >= MAX_DISTINCT_EMOJI_PER_USER_PER_MESSAGE) {
      return createApiError(`You can add at most ${MAX_DISTINCT_EMOJI_PER_USER_PER_MESSAGE} different reactions to one message`, 400)
    }
    if (distinct.length >= MAX_DISTINCT_EMOJI_PER_MESSAGE && !distinct.some((d) => d.emoji === emoji)) {
      return createApiError(`A message can have at most ${MAX_DISTINCT_EMOJI_PER_MESSAGE} different reactions`, 400)
    }
    try {
      await prisma.messageReaction.create({ data: { messageId: id, userId: user.id, emoji } })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    }
    reacted = true
  }

  return createApiResponse({ reacted, reactions: await reactionSummary(prisma, id, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'messaging:react' } })
