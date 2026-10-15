import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { cursorParam, paginateOffset } from '@/lib/api/pagination'

const createSkillSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).optional(),
  category: z.string().min(1).max(50),
  subcategory: z.string().max(50).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
})

const addUserSkillSchema = z.object({
  skillId: z.string(),
  level: z.number().min(1).max(5).default(1),
  yearsExperience: z.number().min(0).max(50).optional(),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  category: z.string().optional(),
  search: z.string().optional(),
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 50
  const category = queryResult.data.category
  const search = queryResult.data.search

  const where: Record<string, unknown> = { isActive: true }
  if (category) where.category = category
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ]
  }

  // Ordered by two columns, so the cursor is a position in that order rather than a keyset.
  const result = await paginateOffset({
    cursor: queryResult.data.cursor,
    page,
    limit,
    where,
    find: (args) =>
      prisma.skill.findMany({
        ...args,
        where: args.where as Prisma.SkillWhereInput,
        orderBy: [{ order: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        include: {
          _count: { select: { userSkills: true } }
        }
      }),
    count: (w) => prisma.skill.count({ where: w as Prisma.SkillWhereInput }),
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  const skills = result.items

  const userSkills = await prisma.userSkill.findMany({
    where: { userId: user.id },
    select: { skillId: true, level: true, isVerified: true }
  })
  const userSkillMap = new Map<string, { level: number; isVerified: boolean }>(
    userSkills.map((s: { skillId: string; level: number; isVerified: boolean }) => [s.skillId, { level: s.level, isVerified: s.isVerified }])
  )

  const skillsWithUserData = skills.map((skill: { id: string }) => ({
    ...skill,
    userLevel: userSkillMap.get(skill.id)?.level || 0,
    isVerified: userSkillMap.get(skill.id)?.isVerified || false,
  }))

  return createApiResponse({
    skills: skillsWithUserData,
    categories: [...new Set(skills.map((s: { category: string }) => s.category))],
    nextCursor: result.nextCursor,
    pagination: result.pagination,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'skills:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('FORBIDDEN')
  }

  const bodyResult = await validateBody(createSkillSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const slug = bodyResult.data.slug || bodyResult.data.name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const existingSlug = await prisma.skill.findUnique({ where: { slug } })
  const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug

  const skill = await prisma.skill.create({
    data: { ...bodyResult.data, slug: finalSlug }
  })

  return createApiResponse(skill, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'skills:create' } })