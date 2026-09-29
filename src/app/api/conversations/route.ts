import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { unreadCountsByConversation, totalUnread } from '@/lib/messaging'
import { z } from 'zod'
import { blockGuardAny } from '@/lib/blocks'

// Only person-to-person and ad-hoc group conversations are created here.
// Team, project and hackathon conversations are created atomically with the
// resource itself; letting a client create one bound to an arbitrary
// teamId/projectId/hackathonId would let anyone squat (or crash on) the single
// conversation slot those resources have.
const createConversationSchema = z.object({
  type: z.enum(['DIRECT', 'GROUP']).default('DIRECT'),
  name: z.string().max(100).optional(),
  participantIds: z.array(z.string().min(1).max(64)).min(1).max(50),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const skip = (page - 1) * limit

  const conversations = await prisma.conversation.findMany({
    where: {
      members: { some: { userId: user.id } }
    },
    skip,
    take: limit,
    orderBy: { updatedAt: 'desc' },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true } } }
      },
      messages: {
        take: 1,
        orderBy: { createdAt: 'desc' },
        include: { sender: { select: { id: true, name: true, username: true } } }
      },
      project: { select: { id: true, name: true, slug: true } },
      team: { select: { id: true, name: true, slug: true } },
      hackathon: { select: { id: true, name: true, slug: true } },
      _count: { select: { messages: true } }
    }
  })

  // One grouped query for the whole page, not one per conversation.
  const unreadByConversation = await unreadCountsByConversation(
    prisma,
    user.id,
    conversations.map((conv) => conv.id)
  )

  const conversationsWithUnread = conversations.map((conv) => {
    // Mask a deleted message before it can leak out as the "last message" preview.
    const messages = conv.messages.map((m: { deletedAt: Date | null; content: string }) => ({
      ...m,
      content: m.deletedAt ? null : m.content,
      isDeleted: Boolean(m.deletedAt),
    }))

    return { ...conv, messages, unreadCount: unreadByConversation.get(conv.id) ?? 0 }
  })

  const total = await prisma.conversation.count({
    where: { members: { some: { userId: user.id } } }
  })

  return createApiResponse({
    conversations: conversationsWithUnread,
    totalUnread: await totalUnread(prisma, user.id),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'conversations:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createConversationSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const { type, name, participantIds } = bodyResult.data

  if (type === 'DIRECT' && participantIds.length !== 1) {
    return createApiError('Direct conversations require exactly 1 participant', 400)
  }

  const allParticipantIds = [...new Set([user.id, ...participantIds])]

  // Every participant must be a real user (an unknown id would otherwise
  // surface as a foreign-key error).
  const knownUsers = await prisma.user.count({ where: { id: { in: allParticipantIds } } })
  if (knownUsers !== allParticipantIds.length) {
    return createApiError('One or more users were not found', 400)
  }

  // No one can start a conversation with a user they have blocked or who has
  // blocked them.
  const blocked = await blockGuardAny(prisma, user.id, participantIds)
  if (blocked) return blocked

  if (type === 'DIRECT') {
    const existing = await prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        members: {
          every: { userId: { in: allParticipantIds } }
        }
      },
      include: { members: true }
    })
    if (existing && existing.members.length === allParticipantIds.length) {
      return createApiResponse(existing)
    }
  }

  const conversation = await prisma.conversation.create({
    data: {
      type,
      name,
      members: {
        create: allParticipantIds.map(id => ({
          userId: id,
          role: id === user.id ? 'OWNER' : 'MEMBER'
        }))
      }
    },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true } } }
      }
    }
  })

  for (const participantId of participantIds) {
    if (participantId !== user.id) {
      await prisma.notification.create({
        data: {
          userId: participantId,
          type: 'NEW_MESSAGE',
          title: 'New conversation',
          message: `${user.name || user.username} started a conversation`,
          link: `/messages/${conversation.id}`,
          metadata: { conversationId: conversation.id }
        }
      })
    }
  }

  return createApiResponse(conversation, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'conversations:create' } })