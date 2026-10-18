import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError, checkMembership, checkOwnership } from '@/lib/api/handler'
import { z } from 'zod'
import { blockGuardAny } from '@/lib/blocks'
import { cursorParam, paginate, withNextCursor } from '@/lib/api/pagination'
import { capacityOf, hackathonLimits, isLocked } from '@/lib/squads/membership'

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: cursorParam,
})

const applySchema = z.object({
  message: z.string().max(1000).optional(),
  // The open slot applied for; accepting fills it.
  slotId: z.string().min(1).max(64).optional(),
})

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const team = await prisma.team.findUnique({ where: { id } })
  if (!team) {
    return createApiError('TEAM_NOT_FOUND')
  }

  // The people who would review this application must not be blocked with,
  // or by, the applicant.
  const reviewers = await prisma.teamMember.findMany({
    where: { teamId: id, role: { in: ['OWNER', 'ADMIN'] } },
    select: { userId: true },
  })
  const blocked = await blockGuardAny(prisma, user.id, [team.ownerId, ...reviewers.map((r) => r.userId)], 'TEAM_NOT_FOUND')
  if (blocked) return blocked

  if (!team.isRecruiting) {
    return createApiError('TEAM_NOT_RECRUITING')
  }

  // Cheap up-front check so a doomed application doesn't sit in the queue
  // pretending it has a chance — the real, race-safe capacity guard lives
  // at accept time (see the [applicationId] route), since that's the only
  // point where two writes can actually race for the same open slot.
  const hackathon = await hackathonLimits(prisma, team.hackathonId)
  if (isLocked(hackathon, new Date())) {
    return createApiError('TEAM_LOCKED')
  }
  const memberCount = await prisma.teamMember.count({ where: { teamId: id } })
  if (memberCount >= capacityOf(team, hackathon)) {
    return createApiError('TEAM_FULL')
  }

  const isMember = await checkMembership(prisma, user.id, 'team', id)
  if (isMember) {
    return createApiError('ALREADY_TEAM_MEMBER')
  }

  const existingApplication = await prisma.teamApplication.findUnique({
    where: { userId_teamId: { userId: user.id, teamId: id } }
  })
  if (existingApplication) {
    return createApiError('ALREADY_APPLIED')
  }

  const bodyResult = await validateBody(applySchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  if (bodyResult.data.slotId) {
    const slot = await prisma.teamSlot.findUnique({ where: { id: bodyResult.data.slotId }, select: { teamId: true, status: true } })
    if (!slot || slot.teamId !== id) return createApiError('SLOT_NOT_FOUND')
    if (slot.status !== 'OPEN') return createApiError('SLOT_NOT_OPEN')
  }

  const application = await prisma.teamApplication.create({
    data: {
      userId: user.id,
      teamId: id,
      message: bodyResult.data.message,
      slotId: bodyResult.data.slotId,
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
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'teams:apply' } })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  const query = validateQuery(listQuerySchema)(request)
  if (query instanceof Response) return query

  // The answer is a bare array, so the cursor for the next page is in the X-Next-Cursor header.
  const result = await paginate({
    cursor: query.data.cursor,
    page: 1,
    limit: query.data.limit ?? 100,
    field: 'createdAt',
    direction: 'desc',
    where: { teamId: id },
    find: (args) =>
      prisma.teamApplication.findMany({
        ...args,
        include: {
          user: {
            select: {
              id: true, name: true, username: true, image: true, headline: true,
              builderRole: true, skills: { include: { skill: true } }
            }
          },
          slot: true
        },
      }),
    count: async () => 0,
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return withNextCursor(createApiResponse(result.items), result.nextCursor)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:applications' } })

// Accept/reject lives at PATCH /api/teams/:id/applications/:applicationId
// (see the [applicationId] route). It used to be defined here, parsing
// applicationId off the URL path — but no route file matched that nested
// path, so it 404'd at the Next.js routing layer on every real call.