import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { awardXp } from '@/lib/xp'
import { recordActivity } from '@/lib/activity'
import { grantAchievement } from '@/lib/achievements'

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

// Forward-only lifecycle: UPCOMING -> ACTIVE -> ENDED, or CANCELLED from
// either of the two non-terminal states. ENDED and CANCELLED are terminal -
// no reopening a hackathon once it's closed out.
const HACKATHON_STATUS_TRANSITIONS: Record<string, string[]> = {
  UPCOMING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ENDED', 'CANCELLED'],
  ENDED: [],
  CANCELLED: [],
}

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

  // Participant creation, XP, activity, achievement, and the confirmation
  // notification all commit atomically - a failure partway through must
  // not leave someone registered with no XP/activity, or vice versa.
  const participant = await prisma.$transaction(async (tx) => {
    const created = await tx.hackathonParticipant.create({
      data: {
        userId: user.id,
        hackathonId: id,
        skills: bodyResult.data.skills,
        lookingFor: bodyResult.data.lookingFor,
      }
    })

    await awardXp(tx, user.id, 'HACKATHON_JOIN', `Joined hackathon "${hackathon.name}"`)
    await recordActivity(tx, user.id, 'HACKATHON_JOINED', `Joined hackathon "${hackathon.name}"`, {
      link: `/hackathons/${hackathon.slug}`
    })
    await grantAchievement(tx, user.id, 'first-hackathon')

    await tx.notification.create({
      data: {
        userId: user.id,
        type: 'HACKATHON_REMINDER',
        title: 'Hackathon registration confirmed',
        message: `You're registered for ${hackathon.name}`,
        link: `/hackathons/${hackathon.slug}`,
        metadata: { hackathonId: id }
      }
    })

    return created
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

  if (bodyResult.data.status) {
    const current = await prisma.hackathon.findUnique({ where: { id }, select: { status: true } })
    if (!current) {
      return createApiError('Hackathon not found', 404)
    }
    const allowed = HACKATHON_STATUS_TRANSITIONS[current.status] ?? []
    if (current.status !== bodyResult.data.status && !allowed.includes(bodyResult.data.status)) {
      return createApiError(`Cannot transition hackathon from ${current.status} to ${bodyResult.data.status}`, 400)
    }
  }

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