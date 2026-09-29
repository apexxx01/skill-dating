import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const createBlockSchema = z.object({
  userId: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
})

const userSummarySelect = { id: true, name: true, username: true, image: true, headline: true } as const

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createBlockSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { userId: targetId, reason } = bodyResult.data

  if (targetId === user.id) {
    return createApiError('You cannot block yourself', 400)
  }

  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
  if (!target) {
    return createApiError('User not found', 404)
  }

  // Creating the block and severing everything between the pair commit
  // together: a block must never exist while a live connection, or a pending
  // request or invitation, still links the two users.
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.block.findUnique({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: targetId } },
      include: { blocked: { select: userSummarySelect } },
    })
    if (existing) {
      return { block: existing, created: false, severedConnections: 0, withdrawnApplications: 0 }
    }

    const block = await tx.block.create({
      data: { blockerId: user.id, blockedId: targetId, reason },
      include: { blocked: { select: userSummarySelect } },
    })

    const severed = await tx.connection.deleteMany({
      where: {
        OR: [
          { senderId: user.id, receiverId: targetId },
          { senderId: targetId, receiverId: user.id },
        ],
      },
    })

    // Pending applications either of them made to a team the other owns, and
    // pending invitations either sent the other, are withdrawn.
    const withdrawn = await tx.teamApplication.updateMany({
      where: {
        status: 'PENDING',
        OR: [
          { userId: user.id, team: { ownerId: targetId } },
          { userId: targetId, team: { ownerId: user.id } },
          { userId: user.id, invitedById: targetId },
          { userId: targetId, invitedById: user.id },
        ],
      },
      data: { status: 'WITHDRAWN' },
    })

    return { block, created: true, severedConnections: severed.count, withdrawnApplications: withdrawn.count }
  })

  return createApiResponse(
    {
      block: {
        id: result.block.id,
        createdAt: result.block.createdAt,
        reason: result.block.reason,
        user: result.block.blocked,
      },
      severedConnections: result.severedConnections,
      withdrawnApplications: result.withdrawnApplications,
    },
    result.created ? 201 : 200
  )
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'blocks:create' } })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const skip = (page - 1) * limit

  // Only the blocks the caller placed. Whether someone else has blocked the
  // caller is deliberately never exposed.
  const where = { blockerId: user.id }
  const [rows, total] = await Promise.all([
    prisma.block.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { blocked: { select: userSummarySelect } },
    }),
    prisma.block.count({ where }),
  ])

  return createApiResponse({
    blocks: rows.map((b) => ({ id: b.id, createdAt: b.createdAt, reason: b.reason, user: b.blocked })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'blocks:list' } })
