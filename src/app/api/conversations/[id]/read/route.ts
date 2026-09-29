import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { markConversationRead, unreadCountsByConversation } from '@/lib/messaging'
import { z } from 'zod'

const readSchema = z.object({
  upToMessageId: z.string().min(1).max(64).optional(),
})

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) {
    return createApiError('Conversation ID required', 400)
  }

  const conversation = await prisma.conversation.findUnique({ where: { id }, select: { id: true } })
  if (!conversation) {
    return createApiError('Conversation not found', 404)
  }

  const isMember = await checkMembership(prisma, user.id, 'conversation', id)
  if (!isMember) {
    return createApiError('Forbidden', 403)
  }

  // Body is optional: an empty body means "mark everything read".
  let upToMessageId: string | undefined
  const raw = await request.text()
  if (raw.trim().length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return createApiError('Invalid JSON', 400)
    }
    const result = readSchema.safeParse(parsed)
    if (!result.success) {
      return createApiError('Validation failed', 400, result.error.flatten().fieldErrors)
    }
    upToMessageId = result.data.upToMessageId
  }

  if (upToMessageId) {
    const boundary = await prisma.message.findUnique({
      where: { id: upToMessageId },
      select: { conversationId: true },
    })
    if (!boundary || boundary.conversationId !== id) {
      return createApiError('upToMessageId does not belong to this conversation', 400)
    }
  }

  const readCount = await markConversationRead(prisma, user.id, id, upToMessageId)
  await prisma.conversationMember.update({
    where: { userId_conversationId: { userId: user.id, conversationId: id } },
    data: { lastReadAt: new Date() },
  })

  const counts = await unreadCountsByConversation(prisma, user.id, [id])
  return createApiResponse({ conversationId: id, readCount, unreadCount: counts.get(id) ?? 0 })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'messaging:read' } })
