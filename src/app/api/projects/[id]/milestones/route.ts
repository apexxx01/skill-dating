import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { advisoryLock, isValidId, loadProjectAccess, projectIdFromPath } from '@/lib/progress'
import { dueDateSchema, milestoneResponse, milestoneSelect } from '@/lib/milestones'

export const MAX_MILESTONES_PER_PROJECT = 100

const createMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  dueDate: dueDateSchema.optional(),
})

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const projectId = projectIdFromPath(request)
  if (!isValidId(projectId)) return createApiError('Project not found', 404)

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('Project not found', 404)
  if (!access.canRead) return createApiError('Forbidden', 403)

  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const page = query.data.page ?? 1
  const limit = query.data.limit ?? 20
  const skip = (page - 1) * limit

  const [milestones, total] = await Promise.all([
    prisma.milestone.findMany({
      where: { projectId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      skip,
      take: limit,
      select: milestoneSelect,
    }),
    prisma.milestone.count({ where: { projectId } }),
  ])

  return createApiResponse({
    milestones: milestones.map(milestoneResponse),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'progress:milestones-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const projectId = projectIdFromPath(request)
  if (!isValidId(projectId)) return createApiError('Project not found', 404)

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('Project not found', 404)
  if (!access.isMember) return createApiError('Forbidden', 403)

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
    return createApiError(`A project can have at most ${MAX_MILESTONES_PER_PROJECT} milestones`, 400)
  }

  return createApiResponse(milestoneResponse(result), 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'progress:milestone-create' } })
