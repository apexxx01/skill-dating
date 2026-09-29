import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import { recordActivity } from '@/lib/activity'
import { blockGuard } from '@/lib/blocks'

const reviewSchema = z.object({
  status: z.enum(['ACCEPTED', 'DECLINED']),
})

const userSummarySelect = { id: true, name: true, username: true, image: true, headline: true } as const

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Connection ID required', 400)
  }

  const bodyResult = await validateBody(reviewSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const connection = await prisma.connection.findUnique({ where: { id } })
  if (!connection) {
    return createApiError('Connection not found', 404)
  }

  // Only the receiver can respond to a request - the sender proposed it,
  // they don't get to also accept it.
  if (connection.receiverId !== user.id) {
    return createApiError('Forbidden', 403)
  }

  if (connection.status !== 'PENDING') {
    return createApiError(`Connection is already ${connection.status.toLowerCase()}`, 400)
  }

  const nextStatus = bodyResult.data.status

  // A request that was pending when a block was placed is severed with the
  // block, so this is a backstop; declining is always allowed.
  if (nextStatus === 'ACCEPTED') {
    const blocked = await blockGuard(prisma, user.id, connection.senderId)
    if (blocked) return blocked
  }

  // Status flip, the DM conversation it unlocks, and the acceptance
  // notification all commit atomically - a failure partway through must
  // never leave an ACCEPTED connection with no shared conversation.
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.connection.update({
      where: { id },
      data: { status: nextStatus },
      include: { sender: { select: userSummarySelect }, receiver: { select: userSummarySelect } },
    })

    if (nextStatus === 'ACCEPTED') {
      const participantIds = [connection.senderId, connection.receiverId].sort()

      // Same existing-DIRECT-conversation lookup as POST /api/conversations:
      // a DM between these two may already exist from before they connected.
      let conversation = await tx.conversation.findFirst({
        where: {
          type: 'DIRECT',
          members: { every: { userId: { in: participantIds } } },
        },
        include: { members: true },
      })

      if (!conversation || conversation.members.length !== participantIds.length) {
        conversation = await tx.conversation.create({
          data: {
            type: 'DIRECT',
            members: {
              create: participantIds.map((id) => ({
                userId: id,
                role: id === connection.senderId ? 'OWNER' : 'MEMBER',
              })),
            },
          },
          include: { members: true },
        })
      }

      await recordActivity(tx, connection.receiverId, 'CONNECTION_ACCEPTED', `Connected with ${result.sender.name || result.sender.username}`, {
        metadata: { connectionId: id, otherUserId: connection.senderId },
      })

      await tx.notification.create({
        data: {
          userId: connection.senderId,
          type: 'CONNECTION',
          title: 'Connection accepted',
          message: `${result.receiver.name || result.receiver.username} accepted your connection request`,
          link: `/messages/${conversation.id}`,
          metadata: { connectionId: id, conversationId: conversation.id },
        },
      })
    }

    return result
  })

  return createApiResponse(updated)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'connections:review' } })
