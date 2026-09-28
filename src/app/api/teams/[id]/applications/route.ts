import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership, checkOwnership } from '@/lib/api/handler'
import { z } from 'zod'

const applySchema = z.object({
  message: z.string().max(1000).optional(),
})

const reviewSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
})

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const team = await prisma.team.findUnique({ where: { id } })
  if (!team) {
    return createApiError('Team not found', 404)
  }

  if (!team.isRecruiting) {
    return createApiError('Team is not recruiting', 400)
  }

  const isMember = await checkMembership(prisma, user.id, 'team', id)
  if (isMember) {
    return createApiError('Already a member of this team', 400)
  }

  const existingApplication = await prisma.teamApplication.findUnique({
    where: { userId_teamId: { userId: user.id, teamId: id } }
  })
  if (existingApplication) {
    return createApiError('Already applied to this team', 400)
  }

  const bodyResult = await validateBody(applySchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const application = await prisma.teamApplication.create({
    data: {
      userId: user.id,
      teamId: id,
      message: bodyResult.data.message,
    },
    include: {
      user: { select: { id: true, name: true, username: true, image: true, headline: true } }
    }
  })

  await prisma.notification.create({
    data: {
      userId: team.ownerId,
      type: 'JOIN_REQUEST',
      title: 'New team application',
      message: `${user.name || user.username} applied to join ${team.name}`,
      link: `/teams/${team.slug}/applications`,
      metadata: { teamId: team.id, applicationId: application.id }
    }
  })

  return createApiResponse(application, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'teams:apply' } })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const applications = await prisma.teamApplication.findMany({
    where: { teamId: id },
    include: {
      user: {
        select: {
          id: true, name: true, username: true, image: true, headline: true,
          builderRole: true, skills: { include: { skill: true } }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  })

  return createApiResponse(applications)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:applications' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]
  const applicationId = url.pathname.split('/').pop()

  if (!id || !applicationId) {
    return createApiError('Team ID and Application ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(reviewSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const application = await prisma.teamApplication.findUnique({
    where: { id: applicationId },
    include: { team: true, user: true }
  })

  if (!application || application.teamId !== id) {
    return createApiError('Application not found', 404)
  }

  if (application.status !== 'PENDING') {
    return createApiError('Application already reviewed', 400)
  }

  const updated = await prisma.teamApplication.update({
    where: { id: applicationId },
    data: { status: bodyResult.data.status }
  })

  if (bodyResult.data.status === 'ACCEPTED') {
    await prisma.teamMember.create({
      data: { userId: application.userId, teamId: id, role: 'MEMBER' }
    })

    await prisma.notification.create({
      data: {
        userId: application.userId,
        type: 'APPLICATION_RESPONSE',
        title: 'Application accepted',
        message: `Your application to join ${application.team.name} was accepted`,
        link: `/teams/${application.team.slug}`,
        metadata: { teamId: application.team.id }
      }
    })
  } else {
    await prisma.notification.create({
      data: {
        userId: application.userId,
        type: 'APPLICATION_RESPONSE',
        title: 'Application declined',
        message: `Your application to join ${application.team.name} was declined`,
        metadata: { teamId: application.team.id }
      }
    })
  }

  return createApiResponse(updated)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:review' } })