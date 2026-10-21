import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, authorize, checkOwnership, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { canAwardShipXp } from '@/lib/rewards-config'
import { currentRewards } from '@/lib/rewards'
import { transactWithEvents } from '@/lib/events'
import { recordShip } from '@/lib/ship'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  shortDesc: z.string().max(300).optional(),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).optional(),
  githubUrl: z.string().max(2048).url().optional().or(z.literal('')),
  demoUrl: z.string().max(2048).url().optional().or(z.literal('')),
  websiteUrl: z.string().max(2048).url().optional().or(z.literal('')),
  techStack: z.array(z.string().max(50)).max(20).optional(),
  lookingFor: z.array(z.string().max(50)).max(20).optional(),
  maxTeamSize: z.number().min(1).max(10).optional(),
  isPublic: z.boolean().optional(),
  thumbnail: z.string().max(2048).url().optional().or(z.literal('')),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'projectId' } })
  }

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, username: true, image: true, headline: true } },
      members: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true } } }
      },
      hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
      updates: {
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: { author: { select: { id: true, name: true, username: true, image: true } } }
      },
      milestones: { orderBy: { order: 'asc' } },
      _count: { select: { members: true, updates: true, milestones: true } }
    }
  })

  if (!project) {
    return createApiError('PROJECT_NOT_FOUND')
  }

  const isOwner = project.ownerId === user.id
  const isMember = project.members.some((m: { userId: string }) => m.userId === user.id)
  const canView = project.isPublic || isOwner || isMember

  if (!canView) {
    return createApiError('FORBIDDEN')
  }

  return createApiResponse({ ...project, isOwner, isMember })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'projects:get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'projectId' } })
  }

  const canEdit = await authorize(prisma, user.id, user.role, 'write', 'project', id)
  if (!canEdit) {
    return createApiError('FORBIDDEN')
  }

  const bodyResult = await validateBody(updateProjectSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const oldProject = await prisma.project.findUnique({ where: { id }, select: { name: true, status: true, shippedAt: true } })

  const updateData: Record<string, unknown> = { ...bodyResult.data }
  if (updateData.name) {
    const slug = String(updateData.name).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '')
    const existingSlug = await prisma.project.findFirst({ where: { slug, id: { not: id } } })
    updateData.slug = existingSlug ? `${slug}-${Date.now()}` : slug
  }

  const projectInclude = {
    owner: { select: { id: true, name: true, username: true, image: true } },
    members: { include: { user: { select: { id: true, name: true, username: true, image: true } } } }
  } as const

  let project
  let rewards
  if (oldProject && canAwardShipXp(oldProject, updateData.status as string | undefined)) {
    updateData.shippedAt = new Date()
    const shippedName = String(updateData.name || oldProject?.name)
    // Ship XP, the reputation event, the activity entry, the achievement
    // grant, and the actual status flip all commit atomically - a failure
    // partway through must not leave a project marked SHIPPED with no XP
    // awarded (or XP awarded with the project not actually updated).
    const shipped = await transactWithEvents(prisma, async (tx) => {
      await recordShip(tx, { userId: user.id, projectId: id, projectName: shippedName })
      return tx.project.update({ where: { id }, data: updateData, include: projectInclude })
    })
    project = shipped.value
    rewards = await shipped.scope.rewardsFor(prisma, user.id)
  } else {
    project = await prisma.project.update({ where: { id }, data: updateData, include: projectInclude })
    rewards = await currentRewards(prisma, user.id)
  }

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'PROJECT_UPDATED', targetType: 'PROJECT', targetId: id, oldValue: oldProject ?? undefined, newValue: updateData as Prisma.InputJsonValue }
  })

  return createApiResponse({ ...project, rewards })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'projects:update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'projectId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'project', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  await prisma.project.delete({ where: { id } })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'PROJECT_DELETED', targetType: 'PROJECT', targetId: id }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'projects:delete' } })