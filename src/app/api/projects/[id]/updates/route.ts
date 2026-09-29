import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { recordActivity } from '@/lib/activity'
import { grantAchievement } from '@/lib/achievements'
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
  if (!isValidId(projectId)) return createApiError('Project not found', 404)

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('Project not found', 404)
  if (!access.canRead) return createApiError('Forbidden', 403)

  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const page = query.data.page ?? 1
  const limit = query.data.limit ?? 20
  const skip = (page - 1) * limit

  const [updates, total] = await Promise.all([
    prisma.projectUpdate.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: limit,
      select: updateSelect,
    }),
    prisma.projectUpdate.count({ where: { projectId } }),
  ])

  return createApiResponse({
    updates,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'progress:updates-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const projectId = projectIdFromPath(request)
  if (!isValidId(projectId)) return createApiError('Project not found', 404)

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return createApiError('Project not found', 404)
  if (!access.isMember) return createApiError('Forbidden', 403)

  const body = await validateBody(createUpdateSchema)(request)
  if (body instanceof Response) return body
  const { title, content, type } = body.data
  const { project } = access

  const created = await prisma.$transaction(async (tx) => {
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
    await grantAchievement(tx, user.id, 'first-update')

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

  return createApiResponse(created, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'progress:update-create' } })
