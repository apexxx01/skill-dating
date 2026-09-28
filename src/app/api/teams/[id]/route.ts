import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, authorize, checkOwnership, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'

const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  maxSize: z.number().min(2).max(10).optional(),
  lookingFor: z.array(z.string()).optional(),
  isRecruiting: z.boolean().optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const team = await prisma.team.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, username: true, image: true, headline: true } },
      members: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true } } }
      },
      project: { select: { id: true, name: true, slug: true, status: true } },
      hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
      applications: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true, skills: { include: { skill: true } } } } },
        orderBy: { createdAt: 'desc' }
      },
      _count: { select: { members: true, applications: true } }
    }
  })

  if (!team) {
    return createApiError('Team not found', 404)
  }

  const isOwner = team.ownerId === user.id
  const isMember = team.members.some((m: { userId: string }) => m.userId === user.id)
  const canView = isOwner || isMember

  if (!canView) {
    return createApiError('Forbidden', 403)
  }

  return createApiResponse({ ...team, isOwner, isMember })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(updateTeamSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const team = await prisma.team.update({
    where: { id },
    data: bodyResult.data,
    include: {
      owner: { select: { id: true, name: true, username: true, image: true } },
      members: { include: { user: { select: { id: true, name: true, username: true, image: true } } } }
    }
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_UPDATED', targetType: 'TEAM', targetId: id, newValue: bodyResult.data }
  })

  return createApiResponse(team)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  await prisma.team.delete({ where: { id } })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_DELETED', targetType: 'TEAM', targetId: id }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'teams:delete' } })