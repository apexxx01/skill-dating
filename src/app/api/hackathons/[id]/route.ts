import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { XP_AWARDS } from '@/lib/xp'

const registerSchema = z.object({
  skills: z.array(z.string()).default([]),
  lookingFor: z.array(z.string()).default([]),
})

const updateHackathonSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  shortDesc: z.string().max(500).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  registrationDeadline: z.string().datetime().optional(),
  status: z.enum(['UPCOMING', 'ACTIVE', 'ENDED', 'CANCELLED']).optional(),
  prizePool: z.string().optional(),
  rules: z.string().max(10000).optional(),
  technologies: z.array(z.string()).optional(),
  maxTeamSize: z.number().min(1).max(10).optional(),
  minTeamSize: z.number().min(1).max(10).optional(),
  location: z.string().optional(),
  isPublic: z.boolean().optional(),
  thumbnail: z.string().url().optional().or(z.literal('')),
  banner: z.string().url().optional().or(z.literal('')),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Hackathon ID required', 400)
  }

  const hackathon = await prisma.hackathon.findUnique({
    where: { id },
    include: {
      participants: {
        include: {
          user: { select: { id: true, name: true, username: true, image: true, headline: true } }
        }
      },
      hackathonTeams: {
        include: {
          team: {
            include: {
              members: { include: { user: { select: { id: true, name: true, username: true, image: true } } } }
            }
          }
        }
      },
      _count: { select: { participants: true, hackathonTeams: true } }
    }
  })

  if (!hackathon) {
    return createApiError('Hackathon not found', 404)
  }

  const participation = await prisma.hackathonParticipant.findUnique({
    where: { userId_hackathonId: { userId: user.id, hackathonId: id } }
  })

  return createApiResponse({ ...hackathon, participation })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'hackathons:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Hackathon ID required', 400)
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('Hackathon not found', 404)
  }

  if (hackathon.status !== 'UPCOMING') {
    return createApiError('Registration closed', 400)
  }

  if (hackathon.registrationDeadline && new Date() > hackathon.registrationDeadline) {
    return createApiError('Registration deadline passed', 400)
  }

  const existing = await prisma.hackathonParticipant.findUnique({
    where: { userId_hackathonId: { userId: user.id, hackathonId: id } }
  })
  if (existing) {
    return createApiError('Already registered', 400)
  }

  const bodyResult = await validateBody(registerSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const participant = await prisma.hackathonParticipant.create({
    data: {
      userId: user.id,
      hackathonId: id,
      skills: bodyResult.data.skills,
      lookingFor: bodyResult.data.lookingFor,
    }
  })

  await prisma.xPEvent.create({
    data: { userId: user.id, type: 'HACKATHON_JOIN', amount: XP_AWARDS.HACKATHON_JOIN, description: `Joined hackathon "${hackathon.name}"` }
  })

  await prisma.notification.create({
    data: {
      userId: user.id,
      type: 'HACKATHON_REMINDER',
      title: 'Hackathon registration confirmed',
      message: `You're registered for ${hackathon.name}`,
      link: `/hackathons/${hackathon.slug}`,
      metadata: { hackathonId: id }
    }
  })

  return createApiResponse(participant, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'hackathons:register' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('Forbidden', 403)
  }

  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Hackathon ID required', 400)
  }

  const bodyResult = await validateBody(updateHackathonSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const updateData: Record<string, unknown> = { ...bodyResult.data }
  if (updateData.startDate) updateData.startDate = new Date(updateData.startDate as string)
  if (updateData.endDate) updateData.endDate = new Date(updateData.endDate as string)
  if (updateData.registrationDeadline) updateData.registrationDeadline = new Date(updateData.registrationDeadline as string)

  const hackathon = await prisma.hackathon.update({
    where: { id },
    data: updateData
  })

  return createApiResponse(hackathon)
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'hackathons:update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Hackathon ID required', 400)
  }

  await prisma.hackathon.delete({ where: { id } })
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 5, keyPrefix: 'hackathons:delete' } })