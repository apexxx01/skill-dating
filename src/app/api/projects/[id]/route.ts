import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, authorize, checkOwnership, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { awardXp, canAwardShipXp } from '@/lib/xp'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  shortDesc: z.string().max(300).optional(),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).optional(),
  githubUrl: z.string().url().optional().or(z.literal('')),
  demoUrl: z.string().url().optional().or(z.literal('')),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  techStack: z.array(z.string()).optional(),
  lookingFor: z.array(z.string()).optional(),
  maxTeamSize: z.number().min(1).max(10).optional(),
  isPublic: z.boolean().optional(),
  thumbnail: z.string().url().optional().or(z.literal('')),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Project ID required', 400)
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
    return createApiError('Project not found', 404)
  }

  const isOwner = project.ownerId === user.id
  const isMember = project.members.some((m: { userId: string }) => m.userId === user.id)
  const canView = project.isPublic || isOwner || isMember

  if (!canView) {
    return createApiError('Forbidden', 403)
  }

  return createApiResponse({ ...project, isOwner, isMember })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'projects:get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Project ID required', 400)
  }

  const canEdit = await authorize(prisma, user.id, user.role, 'write', 'project', id)
  if (!canEdit) {
    return createApiError('Forbidden', 403)
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

  if (oldProject && canAwardShipXp(oldProject, updateData.status as string | undefined)) {
    updateData.shippedAt = new Date()
    await awardXp(prisma, user.id, 'PROJECT_SHIP', `Shipped project "${updateData.name || oldProject?.name}"`)
    await prisma.reputationEvent.create({
      data: { userId: user.id, type: 'PROJECT_SHIPPED', amount: 100, sourceId: id, sourceType: 'PROJECT', description: `Shipped project` }
    })
  }

  const project = await prisma.project.update({
    where: { id },
    data: updateData,
    include: {
      owner: { select: { id: true, name: true, username: true, image: true } },
      members: { include: { user: { select: { id: true, name: true, username: true, image: true } } } }
    }
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'PROJECT_UPDATED', targetType: 'PROJECT', targetId: id, oldValue: oldProject ?? undefined, newValue: updateData as Prisma.InputJsonValue }
  })

  return createApiResponse(project)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'projects:update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Project ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'project', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  await prisma.project.delete({ where: { id } })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'PROJECT_DELETED', targetType: 'PROJECT', targetId: id }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'projects:delete' } })