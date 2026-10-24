import { NextRequest } from 'next/server'
import { withAuth, validateQuery, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import type { Prisma } from '@prisma/client'
import { cursorParam, paginate } from '@/lib/api/pagination'
import { z } from 'zod'

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  unreadOnly: z.coerce.boolean().default(false),
  type: z.string().max(200).optional(),
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const unreadOnly = queryResult.data.unreadOnly ?? false
  const type = queryResult.data.type

  const where: Prisma.NotificationWhereInput = { userId: user.id }
  if (unreadOnly) where.isRead = false
  if (type) where.type = type as Prisma.NotificationWhereInput['type']

  const [result, unreadCount] = await Promise.all([
    paginate({
      cursor: queryResult.data.cursor,
      page,
      limit,
      field: 'createdAt',
      direction: 'desc',
      where,
      find: (args) => prisma.notification.findMany(args),
      count: (w) => prisma.notification.count({ where: w }),
      sortOf: (row) => row.createdAt,
    }),
    prisma.notification.count({ where: { userId: user.id, isRead: false } }),
  ])
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ notifications: result.items, unreadCount, nextCursor: result.nextCursor, pagination: result.pagination })
}, { cache: { maxAge: 0 }, rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'notifications:list' } })

// Bulk mark-as-read on the collection route. Path-segment tricks like
// PATCH /api/notifications/read-all don't reach this file at all (no such
// route exists), so "mark all" is a body flag instead; a single notification
// is marked read via PATCH /api/notifications/[id].
const markAllSchema = z.object({ all: z.literal(true) })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(markAllSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  await prisma.notification.updateMany({
    where: { userId: user.id, isRead: false },
    data: { isRead: true }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:read-all' } })