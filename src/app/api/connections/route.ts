import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { cursorParam, paginate } from '@/lib/api/pagination'
import { blockGuard } from '@/lib/blocks'

const CONNECTION_TYPES = ['TEAMMATE', 'COLLABORATOR', 'MENTOR', 'FRIEND', 'NETWORK'] as const

const createConnectionSchema = z.object({
  receiverId: z.string().min(1),
  type: z.enum(CONNECTION_TYPES).default('NETWORK'),
  message: z.string().max(1000).optional(),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'BLOCKED']).optional(),
  direction: z.enum(['sent', 'received']).optional(),
  cursor: cursorParam,
})

const userSummarySelect = { id: true, name: true, username: true, image: true, headline: true } as const

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createConnectionSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { receiverId, type, message } = bodyResult.data

  if (receiverId === user.id) {
    return createApiError('CANNOT_CONNECT_SELF')
  }

  const receiver = await prisma.user.findUnique({ where: { id: receiverId }, select: { id: true } })
  if (!receiver) {
    return createApiError('USER_NOT_FOUND')
  }

  const blocked = await blockGuard(prisma, user.id, receiverId)
  if (blocked) return blocked

  // Check both directions - a duplicate/conflicting request is still a
  // duplicate/conflicting request whichever way it originally went, and an
  // already-ACCEPTED connection in either direction means they're already
  // connected, full stop.
  const existing = await prisma.connection.findFirst({
    where: {
      OR: [
        { senderId: user.id, receiverId },
        { senderId: receiverId, receiverId: user.id },
      ],
    },
  })

  if (existing) {
    if (existing.status === 'ACCEPTED') {
      return createApiError('CONNECTION_EXISTS')
    }
    if (existing.status === 'PENDING') {
      return createApiError('CONNECTION_PENDING', { details: { existingConnection: existing } })
    }
    // DECLINED/BLOCKED from a prior round - fall through and let a fresh
    // request be sent, but reuse the existing row (unique on
    // [senderId, receiverId]) rather than fight the constraint if the
    // sender/receiver pairing matches exactly; a reversed pairing after a
    // decline just creates its own new row, which is fine.
  }

  const connection = existing && existing.senderId === user.id
    ? await prisma.connection.update({
        where: { id: existing.id },
        data: { type, message, status: 'PENDING' },
        include: { sender: { select: userSummarySelect }, receiver: { select: userSummarySelect } },
      })
    : await prisma.connection.create({
        data: { senderId: user.id, receiverId, type, message },
        include: { sender: { select: userSummarySelect }, receiver: { select: userSummarySelect } },
      })

  await prisma.notification.create({
    data: {
      userId: receiverId,
      type: 'CONNECTION',
      title: 'New connection request',
      message: `${user.name || user.username} wants to connect with you`,
      link: `/connections`,
      metadata: { connectionId: connection.id, senderId: user.id, type },
    },
  })

  return createApiResponse(connection, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'connections:create' } })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status
  const direction = queryResult.data.direction

  const where: Prisma.ConnectionWhereInput = {}
  if (direction === 'sent') where.senderId = user.id
  else if (direction === 'received') where.receiverId = user.id
  else where.OR = [{ senderId: user.id }, { receiverId: user.id }]

  if (status) where.status = status

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.connection.findMany({
        ...args,
        include: { sender: { select: userSummarySelect }, receiver: { select: userSummarySelect } },
      }),
    count: (w) => prisma.connection.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ connections: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'connections:list' } })
