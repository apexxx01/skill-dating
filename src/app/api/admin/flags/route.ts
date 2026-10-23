import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam, decodeKeysetCursor, keysetOrderBy, keysetPage, keysetWhere } from '@/lib/api/pagination'
import { invalidateFlags } from '@/lib/flags'
import { announceAfterFlagChange } from '@/lib/romance/announce'
import { createFlagSchema, flagResponse } from '@/lib/flags-admin'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorParam,
})

// Admin only. Flags are ordered by key, so a cursor is the last key returned.
export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const limit = query.data.limit ?? 50
  const cursor = query.data.cursor

  const position = cursor ? decodeKeysetCursor(cursor) : null
  if (cursor && !position) return createApiError('INVALID_CURSOR')

  const rows = await prisma.featureFlag.findMany({
    where: position ? keysetWhere('key', 'asc', position) : undefined,
    orderBy: keysetOrderBy('key', 'asc'),
    take: limit + 1,
  })
  const page = keysetPage(rows, limit, (row) => ({ sort: row.key, id: row.id }))

  return createApiResponse({ flags: page.items.map(flagResponse), nextCursor: page.nextCursor })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:flags-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(createFlagSchema)(request)
  if (body instanceof Response) return body

  let flag
  try {
    flag = await prisma.featureFlag.create({ data: { ...body.data, updatedById: user.id } })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return createApiError('FLAG_EXISTS')
    throw error
  }

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'FEATURE_FLAG_CREATED', targetType: 'FEATURE_FLAG', targetId: flag.key, newValue: flagResponse(flag) as unknown as Prisma.InputJsonValue },
  })
  await invalidateFlags()
  await announceAfterFlagChange(flag.key)

  return createApiResponse(flagResponse(flag), 201)
}, { requiredRole: ['ADMIN'], idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:flags-create' } })
