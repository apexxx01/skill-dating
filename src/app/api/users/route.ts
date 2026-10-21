import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import { blockedUserIds } from '@/lib/blocks'
import { isValidTimeZone } from '@/lib/time'
import type { Prisma } from '@prisma/client'
import { cursorParam, paginate } from '@/lib/api/pagination'
import { trackOnboardingIfComplete } from '@/lib/onboarding'
import { parseBirthDate } from '@/lib/age'
import { isMinor } from '@/lib/age-policy'
import { setBirthDate } from '@/lib/birth-date'
import { MIN_PLATFORM_AGE } from '@/lib/age-policy'

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  headline: z.string().max(200).optional(),
  location: z.string().max(100).optional(),
  // An IANA name such as "Asia/Kolkata": it decides where this person's day starts (caps, streaks).
  timezone: z.string().max(50).refine(isValidTimeZone, 'must be an IANA time zone such as "Europe/Paris"').optional(),
  availability: z.string().max(200).optional(),
  builderRole: z.string().max(100).optional(),
  website: z.string().max(2048).url().optional().or(z.literal('')),
  githubUsername: z.string().max(100).optional(),
  twitterUsername: z.string().max(100).optional(),
  linkedinUrl: z.string().max(2048).url().optional().or(z.literal('')),
  // PRIVATE, and required to finish onboarding (docs/SAFETY.md). Set once and then locked; under 16 is refused; nobody but the owner ever reads it back.
  birthDate: z.string().max(32).refine((value) => parseBirthDate(value) !== null, 'A real date in the past such as 1995-06-15').optional(),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  skills: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult
  
  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const search = queryResult.data.search
  const skills = queryResult.data.skills
  const location = queryResult.data.location

  const hidden = await blockedUserIds(prisma, user.id)
  const where: Record<string, unknown> = {
    // Invisible mode (a privacy setting) keeps a person out of search and discovery.
    NOT: { profile: { invisibleMode: true } },
    id: { not: user.id, ...(hidden.length ? { notIn: hidden } : {}) },
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

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'xp',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.user.findMany({
        ...args,
        where: args.where as Prisma.UserWhereInput,
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
    count: (w) => prisma.user.count({ where: w as Prisma.UserWhereInput }),
    sortOf: (row) => row.xp,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  const users = result.items

  return createApiResponse({
    users,
    nextCursor: result.nextCursor,
    pagination: result.pagination,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:list' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(updateProfileSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  // The date of birth first: a person refused for their age changes nothing else, and a new minor's place is cleared before anything is written.
  const { birthDate: birthDateText, ...fields } = bodyResult.data
  if (birthDateText) {
    const outcome = await setBirthDate(prisma, user.id, parseBirthDate(birthDateText)!)
    if (outcome.kind === 'REFUSED') return createApiError('AGE_BELOW_MINIMUM', { params: { minAge: MIN_PLATFORM_AGE } })
    if (outcome.kind === 'LOCKED') return createApiError('BIRTH_DATE_LOCKED')
  }
  // A minor may share a country and nothing finer, so no free-text place.
  if (fields.location && isMinor((await prisma.user.findUnique({ where: { id: user.id }, select: { birthDate: true } }))?.birthDate)) {
    return createApiError('MINOR_LOCATION_LIMITED')
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: fields,
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
      // Never the date of birth: it is not for the log.
      newValue: fields,
    }
  })

  if (bodyResult.data.headline || birthDateText) await trackOnboardingIfComplete(prisma, user.id)

  return createApiResponse(updatedUser)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'users:update' } })