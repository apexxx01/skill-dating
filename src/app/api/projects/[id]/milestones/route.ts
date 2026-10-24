import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { advisoryLock, isValidId, loadProjectAccess, projectIdFromPath } from '@/lib/progress'
import { paginateOffset } from '@/lib/api/pagination'
import { MAX_MILESTONES_PER_PROJECT, milestoneResponse, milestoneSelect } from '@/lib/milestones'
import { createMilestoneSchema, querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const projectId = projectIdFromPath(request)
  if (!isValidId(projectId)) return createApiError('PROJECT_NOT_FOUND')

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('PROJECT_NOT_FOUND')
  if (!access.canRead) return createApiError('FORBIDDEN')

  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const page = query.data.page ?? 1
  const limit = query.data.limit ?? 20

  // Ordered by position, then creation: a cursor is a position in that order.
  const result = await paginateOffset({
    cursor: query.data.cursor,
    page,
    limit,
    where: { projectId },
    find: (args) =>
      prisma.milestone.findMany({
        ...args,
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: milestoneSelect,
      }),
    count: (where) => prisma.milestone.count({ where }),
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({
    milestones: result.items.map(milestoneResponse),
    nextCursor: result.nextCursor,
    pagination: result.pagination,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'progress:milestones-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const projectId = projectIdFromPath(request)
  if (!isValidId(projectId)) return createApiError('PROJECT_NOT_FOUND')

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('PROJECT_NOT_FOUND')
  if (!access.isMember) return createApiError('FORBIDDEN')

  const body = await validateBody(createMilestoneSchema)(request)
  if (body instanceof Response) return body

  // The per-project lock makes count-then-insert exact: parallel creates for
  // one project run one at a time, so the 100 cap cannot be overshot and the
  // appended `order` values never collide.
  const result = await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `milestones:${projectId}`)

    const [count, last] = await Promise.all([
      tx.milestone.count({ where: { projectId } }),
      tx.milestone.findFirst({ where: { projectId }, orderBy: { order: 'desc' }, select: { order: true } }),
    ])
    if (count >= MAX_MILESTONES_PER_PROJECT) return null

    return tx.milestone.create({
      data: {
        projectId,
        title: body.data.title,
        description: body.data.description || null,
        dueDate: body.data.dueDate ? new Date(body.data.dueDate) : null,
        order: (last?.order ?? -1) + 1,
      },
      select: milestoneSelect,
    })
  })

  if (!result) {
    return createApiError('MILESTONE_LIMIT_REACHED', { params: { max: MAX_MILESTONES_PER_PROJECT } })
  }

  return createApiResponse(milestoneResponse(result), 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'progress:milestone-create' } })
