import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { calculateSkillCompatibility, type SkillRef } from '@/lib/scoring'
import { z } from 'zod'
import { blockedUserIds } from '@/lib/blocks'

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().optional(),
  skills: z.string().optional(),
  location: z.string().optional(),
})

// Compatibility is computed per-request against a candidate pool, not
// stored, so ranking the entire user table by score on every call isn't
// viable as the platform grows. Instead: fetch a bounded, filtered pool
// ordered by recency, score+sort that pool in memory, then paginate the
// ranked result. `pagination.total` reflects the true filtered count (for
// "N people match"), while `pagination.totalPages` reflects the ranked,
// paginatable pool — the two intentionally diverge once total exceeds the pool.
const CANDIDATE_POOL_SIZE = 100

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const { search, skills, location } = queryResult.data

  // Users blocked in either direction never appear.
  const hidden = await blockedUserIds(prisma, user.id)
  const where: Record<string, unknown> = { id: { not: user.id, ...(hidden.length ? { notIn: hidden } : {}) } }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } },
      { bio: { contains: search, mode: 'insensitive' } },
      { headline: { contains: search, mode: 'insensitive' } },
    ]
  }
  if (skills) {
    const skillSlugs = skills.split(',').map(s => s.trim()).filter(Boolean)
    where.skills = { some: { skill: { slug: { in: skillSlugs } } } }
  }
  if (location) {
    where.location = { contains: location, mode: 'insensitive' }
  }

  const [currentUser, total, candidatePool] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        skills: { select: { skillId: true, level: true, skill: { select: { category: true } } } }
      }
    }),
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      take: CANDIDATE_POOL_SIZE,
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true, name: true, username: true, image: true, headline: true,
        location: true, builderRole: true, xp: true, rank: true,
        reputationScore: true, githubUsername: true, createdAt: true,
        skills: {
          take: 10,
          include: { skill: { select: { id: true, name: true, slug: true, category: true, color: true } } }
        },
      }
    }),
  ])

  const myProfile: SkillRef[] = (currentUser?.skills ?? []).map(s => ({
    skillId: s.skillId, level: s.level, category: s.skill.category
  }))

  const scored = candidatePool.map(candidate => {
    const candidateProfile: SkillRef[] = candidate.skills.map(s => ({
      skillId: s.skillId, level: s.level, category: s.skill.category
    }))
    const { score } = calculateSkillCompatibility(myProfile, candidateProfile)
    return { ...candidate, compatibility: score }
  })

  scored.sort((a, b) => b.compatibility - a.compatibility)

  const skip = (page - 1) * limit
  const people = scored.slice(skip, skip + limit)

  return createApiResponse({
    people,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(Math.min(total, CANDIDATE_POOL_SIZE) / limit),
    },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'discover:list' } })
