import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const addUserSkillSchema = z.object({
  skillId: z.string(),
  level: z.number().min(1).max(5).default(1),
  yearsExperience: z.number().min(0).max(50).optional(),
})

const updateUserSkillSchema = z.object({
  level: z.number().min(1).max(5).optional(),
  yearsExperience: z.number().min(0).max(50).optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('User ID required', 400)
  }

  const userSkills = await prisma.userSkill.findMany({
    where: { userId: id },
    include: {
      skill: { select: { id: true, name: true, slug: true, category: true, subcategory: true, icon: true, color: true } }
    },
    orderBy: [{ level: 'desc' }, { skill: { name: 'asc' } }]
  })

  return createApiResponse(userSkills)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'user-skills:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('User ID required', 400)
  }

  if (id !== user.id && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(addUserSkillSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const skill = await prisma.skill.findUnique({ where: { id: bodyResult.data.skillId } })
  if (!skill) {
    return createApiError('Skill not found', 404)
  }

  const existing = await prisma.userSkill.findUnique({
    where: { userId_skillId: { userId: id, skillId: bodyResult.data.skillId } }
  })
  if (existing) {
    return createApiError('Skill already added', 400)
  }

  const userSkill = await prisma.userSkill.create({
    data: {
      userId: id,
      skillId: bodyResult.data.skillId,
      level: bodyResult.data.level,
      yearsExperience: bodyResult.data.yearsExperience || 0,
    },
    include: { skill: true }
  })

  return createApiResponse(userSkill, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'user-skills:add' } })