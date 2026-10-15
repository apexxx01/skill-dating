import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { recordActivity } from '@/lib/activity'
import { emit, transactWithEvents } from '@/lib/events'
import { cursorParam, paginate } from '@/lib/api/pagination'
import {
  authorSelect,
  isValidId,
  loadProjectAccess,
  projectIdFromPath,
} from '@/lib/progress'

// MILESTONE and SHIPPED updates are written by the system (milestone
// completion, shipping); clients can only post these two kinds.
const createUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(10000),
  type: z.enum(['UPDATE', 'ANNOUNCEMENT']).default('UPDATE'),
})

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursorParam,
})

const updateSelect = {
  id: true,
  projectId: true,
  title: true,
  content: true,
  type: true,
  createdAt: true,
  author: { select: authorSelect },
} as const

const MAX_NOTIFIED_MEMBERS = 200

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

  const result = await paginate({
    cursor: query.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where: { projectId },
    find: (args) => prisma.projectUpdate.findMany({ ...args, select: updateSelect }),
    count: (where) => prisma.projectUpdate.count({ where }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ updates: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'progress:updates-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const projectId = projectIdFromPath(request)
  if (!isValidId(projectId)) return createApiError('PROJECT_NOT_FOUND')

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('PROJECT_NOT_FOUND')
  if (!access.isMember) return createApiError('FORBIDDEN')

  const body = await validateBody(createUpdateSchema)(request)
  if (body instanceof Response) return body
  const { title, content, type } = body.data
  const { project } = access

  const { value: created, scope } = await transactWithEvents(prisma, async (tx) => {
    const update = await tx.projectUpdate.create({
      data: { projectId, authorId: user.id, title, content, type },
      select: updateSelect,
    })

    await recordActivity(tx, user.id, 'PROJECT_UPDATE_POSTED', `Posted an update on "${project.name}"`, {
      description: title,
      link: `/projects/${project.slug}`,
      projectId,
      metadata: { updateId: update.id },
    })
    await emit(tx, 'PROJECT_UPDATE_POSTED', { userId: user.id, projectId, updateId: update.id })

    const others = await tx.projectMember.findMany({
      where: { projectId, userId: { not: user.id } },
      select: { userId: true },
      take: MAX_NOTIFIED_MEMBERS,
    })
    if (others.length > 0) {
      await tx.notification.createMany({
        data: others.map((member) => ({
          userId: member.userId,
          type: 'PROJECT_UPDATE' as const,
          title: 'New project update',
          message: `${user.name || user.username || 'A teammate'} posted "${title}" in ${project.name}`,
          link: `/projects/${project.slug}`,
          metadata: { projectId, updateId: update.id },
        })),
      })
    }

    return update
  })

  return createApiResponse({ ...created, rewards: await scope.rewardsFor(prisma, user.id) }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'progress:update-create' } })
