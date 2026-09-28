import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const createHackathonSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  shortDesc: z.string().max(500).optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  registrationDeadline: z.string().datetime().optional(),
  organizer: z.string().optional(),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  prizePool: z.string().optional(),
  rules: z.string().max(10000).optional(),
  technologies: z.array(z.string()).default([]),
  maxTeamSize: z.number().min(1).max(10).default(5),
  minTeamSize: z.number().min(1).max(10).default(1),
  location: z.string().optional(),
  isPublic: z.boolean().default(true),
  thumbnail: z.string().url().optional().or(z.literal('')),
  banner: z.string().url().optional().or(z.literal('')),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['UPCOMING', 'ACTIVE', 'ENDED', 'CANCELLED']).optional(),
  search: z.string().optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status
  const search = queryResult.data.search
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = { isPublic: true }
  if (status) where.status = status
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ]
  }

  const [hackathons, total] = await Promise.all([
    prisma.hackathon.findMany({
      where,
      skip,
      take: limit,
      orderBy: { startDate: 'asc' },
      include: {
        _count: { select: { participants: true, teams: true } }
      }
    }),
    prisma.hackathon.count({ where })
  ])

  return createApiResponse({
    hackathons,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'hackathons:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('Forbidden', 403)
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
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'hackathons:create' } })