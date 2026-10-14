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
import { blockGuardAny } from '@/lib/blocks'

const reactSchema = z.object({
  emoji: z.string().min(1).max(16).refine(isValidEmoji, 'Must be a single emoji'),
})

function messageIdFrom(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/').slice(-2)[0]
}

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = messageIdFrom(request)
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'messageId' } })

  const message = await prisma.message.findUnique({ where: { id }, select: { conversationId: true } })
  if (!message) return createApiError('MESSAGE_NOT_FOUND')

  if (!(await checkMembership(prisma, user.id, 'conversation', message.conversationId))) {
    return createApiError('FORBIDDEN')
  }

  return createApiResponse({ messageId: id, reactions: await reactionSummary(prisma, id, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'messaging:reactions:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = messageIdFrom(request)
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'messageId' } })

  const message = await prisma.message.findUnique({
    where: { id },
    select: { conversationId: true, deletedAt: true },
  })
  if (!message) return createApiError('MESSAGE_NOT_FOUND')

  if (!(await checkMembership(prisma, user.id, 'conversation', message.conversationId))) {
    return createApiError('FORBIDDEN')
  }
  if (message.deletedAt) return createApiError('MESSAGE_DELETED')

  // Reacting in a direct conversation is addressed to one person, so it is
  // closed while either side has blocked the other (shared rooms stay open).
  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    select: { type: true, members: { select: { userId: true } } },
  })
  if (conversation?.type === 'DIRECT') {
    const blocked = await blockGuardAny(prisma, user.id, conversation.members.map((m) => m.userId), 'MESSAGE_NOT_FOUND')
    if (blocked) return blocked
  }

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
      return createApiError('REACTION_LIMIT_PER_USER', { params: { max: MAX_DISTINCT_EMOJI_PER_USER_PER_MESSAGE } })
    }
    if (distinct.length >= MAX_DISTINCT_EMOJI_PER_MESSAGE && !distinct.some((d) => d.emoji === emoji)) {
      return createApiError('REACTION_LIMIT_PER_MESSAGE', { params: { max: MAX_DISTINCT_EMOJI_PER_MESSAGE } })
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
