import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkOwnership } from '@/lib/api/handler'
import { z } from 'zod'

const editMessageSchema = z.object({
  content: z.string().min(1).max(10000),
})

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Message ID required', 400)
  }

  const message = await prisma.message.findUnique({ where: { id } })
  if (!message) {
    return createApiError('Message not found', 404)
  }
  if (message.deletedAt) {
    return createApiError('Cannot edit a deleted message', 400)
  }

  // Only the sender can edit their own message — no admin override here
  // (unlike delete, editing someone else's words isn't a moderation action).
  const isSender = await checkOwnership(prisma, user.id, 'message', id)
  if (!isSender) {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(editMessageSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const updated = await prisma.message.update({
    where: { id },
    data: { content: bodyResult.data.content, editedAt: new Date() },
    include: { sender: { select: { id: true, name: true, username: true, image: true } } }
  })

  return createApiResponse(updated)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'messages:edit' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Message ID required', 400)
  }

  const message = await prisma.message.findUnique({ where: { id } })
  if (!message) {
    return createApiError('Message not found', 404)
  }
  if (message.deletedAt) {
    return createApiError('Message already deleted', 400)
  }

  const isSender = await checkOwnership(prisma, user.id, 'message', id)
  const conversationMember = await prisma.conversationMember.findUnique({
    where: { userId_conversationId: { userId: user.id, conversationId: message.conversationId } }
  })
  const isConversationModerator = conversationMember?.role === 'OWNER' || conversationMember?.role === 'ADMIN'

  if (!isSender && !isConversationModerator && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  // Soft delete: content is preserved in the DB (moderation/audit trail,
  // consistent with Report/ModerationAction elsewhere in the schema) but
  // GET /api/conversations/[id] masks it before it ever reaches a client.
  await prisma.message.update({
    where: { id },
    data: { deletedAt: new Date() }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'messages:delete' } })
