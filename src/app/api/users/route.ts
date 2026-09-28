import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  headline: z.string().max(200).optional(),
  location: z.string().max(100).optional(),
  timezone: z.string().max(50).optional(),
  availability: z.string().max(200).optional(),
  builderRole: z.string().max(100).optional(),
  website: z.string().url().optional().or(z.literal('')),
  githubUsername: z.string().max(100).optional(),
  twitterUsername: z.string().max(100).optional(),
  linkedinUrl: z.string().url().optional().or(z.literal('')),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().optional(),
  skills: z.string().optional(),
  location: z.string().optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult
  
  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const search = queryResult.data.search
  const skills = queryResult.data.skills
  const location = queryResult.data.location
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = {
    id: { not: user.id },
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } },
      { bio: { contains: search, mode: 'insensitive' } },
      { headline: { contains: search, mode: 'insensitive' } },
    ]
  }

  if (skills) {
    const skillList = skills.split(',').map(s => s.trim())
    where.skills = {
      some: {
        skill: { slug: { in: skillList } }
      }
    }
  }

  if (location) {
    where.location = { contains: location, mode: 'insensitive' }
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { xp: 'desc' },
      select: {
        id: true,
        name: true,
        username: true,
        image: true,
        headline: true,
        location: true,
        builderRole: true,
        xp: true,
        rank: true,
        reputationScore: true,
        githubUsername: true,
        createdAt: true,
        skills: {
          take: 10,
          include: {
            skill: { select: { id: true, name: true, slug: true, category: true, color: true } }
          }
        },
      }
    }),
    prisma.user.count({ where })
  ])

  return createApiResponse({
    users,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:list' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(updateProfileSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: bodyResult.data,
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      image: true,
      bio: true,
      headline: true,
      location: true,
      timezone: true,
      availability: true,
      builderRole: true,
      website: true,
      githubUsername: true,
      twitterUsername: true,
      linkedinUrl: true,
      xp: true,
      rank: true,
      reputationScore: true,
      role: true,
      verificationLevel: true,
      createdAt: true,
      updatedAt: true,
    }
  })

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: 'PROFILE_UPDATED',
      targetType: 'USER',
      targetId: user.id,
      newValue: bodyResult.data,
    }
  })

  return createApiResponse(updatedUser)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'users:update' } })