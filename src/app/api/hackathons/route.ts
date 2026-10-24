import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import type { Prisma } from '@prisma/client'
import { paginate } from '@/lib/api/pagination'
import { isUnverified } from '@/lib/squads/external-create'
import { createHackathonSchema, querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status
  const search = queryResult.data.search

  const where: Record<string, unknown> = { isPublic: true }
  if (status) where.status = status
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ]
  }

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'startDate',
    direction: 'asc',
    where,
    find: (args) =>
      prisma.hackathon.findMany({
        ...args,
        where: args.where as Prisma.HackathonWhereInput,
        include: {
          _count: { select: { participants: true, teams: true } }
        }
      }),
    count: (w) => prisma.hackathon.count({ where: w as Prisma.HackathonWhereInput }),
    sortOf: (row) => row.startDate,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  const hackathons = result.items

  // Whether the viewer is registered, and which team they entered with, in
  // one query for the whole page - the list needs this to choose between a
  // "Register" and a "My team" action without a request per hackathon.
  const participations = await prisma.hackathonParticipant.findMany({
    where: { userId: user.id, hackathonId: { in: hackathons.map((h) => h.id) } },
    select: { hackathonId: true, teamId: true, status: true },
  })
  const participationByHackathon = new Map(participations.map((p) => [p.hackathonId, p]))

  return createApiResponse({
    hackathons: hackathons.map((h) => {
      const mine = participationByHackathon.get(h.id)
      return { ...h, unverified: isUnverified(h), registered: Boolean(mine), myTeamId: mine?.teamId ?? null, myStatus: mine?.status ?? null }
    }),
    nextCursor: result.nextCursor,
    pagination: result.pagination,
  })
}, { cache: { maxAge: 30 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'hackathons:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('FORBIDDEN')
  }

  const bodyResult = await validateBody(createHackathonSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const slug = bodyResult.data.name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const existingSlug = await prisma.hackathon.findUnique({ where: { slug } })
  const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug

  // The hackathon's own coordination channel forms atomically with the
  // hackathon itself, same reasoning as team/project creation. The
  // organizer (this caller) starts as its sole member; individual
  // registrants joining it automatically is a separate, larger product
  // decision not made here.
  const hackathon = await prisma.$transaction(async (tx) => {
    const created = await tx.hackathon.create({
      data: {
        ...bodyResult.data,
        slug: finalSlug,
        startDate: new Date(bodyResult.data.startDate),
        endDate: new Date(bodyResult.data.endDate),
        registrationDeadline: bodyResult.data.registrationDeadline ? new Date(bodyResult.data.registrationDeadline) : null,
        submissionDeadline: bodyResult.data.submissionDeadline ? new Date(bodyResult.data.submissionDeadline) : null,
        tracks: bodyResult.data.tracks.map((track) => ({ name: track.name, description: track.description ?? null })),
      }
    })

    await tx.conversation.create({
      data: {
        type: 'HACKATHON',
        hackathonId: created.id,
        members: { create: { userId: user.id, role: 'OWNER' } }
      }
    })

    return created
  })

  return createApiResponse(hackathon, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'hackathons:create' } })