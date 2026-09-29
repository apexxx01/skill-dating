import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { blockGuardAny } from '@/lib/blocks'

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  type: z.enum(['TEXT', 'IMAGE', 'FILE', 'CODE', 'LINK_PREVIEW']).default('TEXT'),
  replyToId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Conversation ID required', 400)
  }

  const isMember = await checkMembership(prisma, user.id, 'conversation', id)
  if (!isMember) {
    return createApiError('Forbidden', 403)
  }

  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 50
  const before = queryResult.data.before
  const skip = (page - 1) * limit

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true } } }
      },
      project: { select: { id: true, name: true, slug: true } },
      team: { select: { id: true, name: true, slug: true } },
      hackathon: { select: { id: true, name: true, slug: true } },
    }
  })

  if (!conversation) {
    return createApiError('Conversation not found', 404)
  }

  const where: Record<string, unknown> = { conversationId: id }
  if (before) where.createdAt = { lt: new Date(before) }

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, name: true, username: true, image: true } },
        replyTo: {
          include: { sender: { select: { id: true, name: true, username: true } } }
        },
        reactions: {
          include: { user: { select: { id: true, name: true, username: true } } }
        },
        _count: { select: { reactions: true, reads: true } }
      }
    }),
    prisma.message.count({ where })
  ])

  await prisma.conversationMember.update({
    where: { userId_conversationId: { userId: user.id, conversationId: id } },
    data: { lastReadAt: new Date() }
  })

  // Soft-deleted messages keep their content in the DB (moderation/audit
  // trail) but must never reach a client — mask both the top-level row and
  // a deleted message quoted via replyTo.
  const maskDeleted = <T extends { deletedAt: Date | null; content: string }>(m: T) => ({
    ...m,
    content: m.deletedAt ? null : m.content,
    isDeleted: Boolean(m.deletedAt),
  })
  const maskedMessages = messages.reverse().map(m => ({
    ...maskDeleted(m),
    replyTo: m.replyTo ? maskDeleted(m.replyTo) : null,
  }))

  return createApiResponse({
    conversation,
    messages: maskedMessages,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'conversations:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Conversation ID required', 400)
  }

  const isMember = await checkMembership(prisma, user.id, 'conversation', id)
  if (!isMember) {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(sendMessageSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  // A direct conversation is a message addressed to one person, so it is
  // closed while either side has blocked the other. Shared team, project and
  // hackathon rooms are not addressed to an individual and stay open.
  const conversationInfo = await prisma.conversation.findUnique({
    where: { id },
    select: { type: true, members: { select: { userId: true } } },
  })
  if (conversationInfo?.type === 'DIRECT') {
    const blocked = await blockGuardAny(
      prisma,
      user.id,
      conversationInfo.members.map((m) => m.userId),
      'Conversation not found'
    )
    if (blocked) return blocked
  }

  const message = await prisma.message.create({
    data: {
      conversationId: id,
      senderId: user.id,
      content: bodyResult.data.content,
      type: bodyResult.data.type,
      replyToId: bodyResult.data.replyToId,
      metadata: bodyResult.data.metadata as Prisma.InputJsonValue | undefined,
    },
    include: {
      sender: { select: { id: true, name: true, username: true, image: true } },
      replyTo: { include: { sender: { select: { id: true, name: true, username: true } } } }
    }
  })

  await prisma.conversation.update({
    where: { id },
    data: { updatedAt: new Date() }
  })

  const otherMembers = await prisma.conversationMember.findMany({
    where: { conversationId: id, userId: { not: user.id } },
    select: { userId: true }
  })

  await prisma.notification.createMany({
    data: otherMembers.map((m: { userId: string }) => ({
      userId: m.userId,
      type: 'NEW_MESSAGE',
      title: 'New message',
      message: `${user.name || user.username}: ${bodyResult.data.content.slice(0, 100)}`,
      link: `/messages/${id}`,
      metadata: { conversationId: id, messageId: message.id }
    }))
  })

  return createApiResponse(message, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'conversations:send' } })