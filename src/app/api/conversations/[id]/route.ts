import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { blockGuardAny } from '@/lib/blocks'
import { markMessagesRead } from '@/lib/messaging'
import { emit, transactWithEvents } from '@/lib/events'
import { advisoryLock } from '@/lib/progress'
import { cursorParam, paginate } from '@/lib/api/pagination'

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
  // Older messages: the nextCursor of the previous (newer) page.
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'conversationId' } })
  }

  const isMember = await checkMembership(prisma, user.id, 'conversation', id)
  if (!isMember) {
    return createApiError('FORBIDDEN')
  }

  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 50
  const before = queryResult.data.before

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
    return createApiError('CONVERSATION_NOT_FOUND')
  }

  const where: Record<string, unknown> = { conversationId: id }
  if (before) where.createdAt = { lt: new Date(before) }

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.message.findMany({
        ...args,
        where: args.where as Prisma.MessageWhereInput,
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
    count: (w) => prisma.message.count({ where: w as Prisma.MessageWhereInput }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  const messages = result.items

  await prisma.conversationMember.update({
    where: { userId_conversationId: { userId: user.id, conversationId: id } },
    data: { lastReadAt: new Date() }
  })

  // Opening a conversation marks as read exactly the messages this response
  // returns (from other senders, not deleted) - an older page must not mark
  // newer, unseen messages read.
  await markMessagesRead(
    prisma,
    user.id,
    messages.filter(m => m.senderId !== user.id && !m.deletedAt).map(m => m.id)
  )

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
    // Continue with this to get the next older page.
    nextCursor: result.nextCursor,
    pagination: result.pagination,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'conversations:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'conversationId' } })
  }

  const isMember = await checkMembership(prisma, user.id, 'conversation', id)
  if (!isMember) {
    return createApiError('FORBIDDEN')
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
      'CONVERSATION_NOT_FOUND'
    )
    if (blocked) return blocked
  }

  const direct = conversationInfo?.type === 'DIRECT' ? conversationInfo : null

  // The message, the conversation's activity stamp, the notifications and the
  // first-message check commit together. For a direct conversation the first
  // message is decided under a lock on the conversation, so two messages sent
  // at the same moment cannot both count as the first.
  const { value: message, scope } = await transactWithEvents(prisma, async (tx) => {
    if (direct) await advisoryLock(tx, `first-message:${id}`)

    const created = await tx.message.create({
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

    await tx.conversation.update({
      where: { id },
      data: { updatedAt: new Date() }
    })

    const otherMembers = await tx.conversationMember.findMany({
      where: { conversationId: id, userId: { not: user.id } },
      select: { userId: true }
    })

    await tx.notification.createMany({
      data: otherMembers.map((m: { userId: string }) => ({
        userId: m.userId,
        type: 'NEW_MESSAGE' as const,
        title: 'New message',
        message: `${user.name || user.username}: ${bodyResult.data.content.slice(0, 100)}`,
        link: `/messages/${id}`,
        metadata: { conversationId: id, messageId: created.id }
      }))
    })

    const recipient = direct?.members.find((member) => member.userId !== user.id)

    // Answering somebody who was waiting on you: the message before this one, in a direct conversation,
    // came from the other person.
    if (recipient) {
      const previous = await tx.message.findFirst({
        where: { conversationId: id, id: { not: created.id }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { senderId: true },
      })
      if (previous && previous.senderId !== user.id) {
        await emit(tx, 'MESSAGE_REPLIED', { userId: user.id, conversationId: id, messageId: created.id, repliedToUserId: previous.senderId })
      }
    }

    if (recipient && (await tx.message.count({ where: { conversationId: id } })) === 1) {
      const connected = await tx.connection.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { senderId: user.id, receiverId: recipient.userId },
            { senderId: recipient.userId, receiverId: user.id },
          ],
        },
        select: { id: true },
      })
      if (connected) {
        await emit(tx, 'MESSAGE_SENT_FIRST_IN_CONNECTION', {
          userId: user.id,
          recipientId: recipient.userId,
          conversationId: id,
          messageId: created.id,
        })
      }
    }

    return created
  })

  return createApiResponse({ ...message, rewards: await scope.rewardsFor(prisma, user.id) }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'conversations:send' } })