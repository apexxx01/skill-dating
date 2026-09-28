import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const updateUserSkillSchema = z.object({
  level: z.number().min(1).max(5).optional(),
  yearsExperience: z.number().min(0).max(50).optional(),
})

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const id = pathParts[pathParts.length - 3]
  const skillId = pathParts[pathParts.length - 1]

  if (!id || !skillId) {
    return createApiError('User ID and Skill ID required', 400)
  }

  if (id !== user.id && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(updateUserSkillSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const existing = await prisma.userSkill.findUnique({
    where: { userId_skillId: { userId: id, skillId } }
  })
  if (!existing) {
    return createApiError('Skill not found for user', 404)
  }

  const userSkill = await prisma.userSkill.update({
    where: { userId_skillId: { userId: id, skillId } },
    data: bodyResult.data,
    include: { skill: true }
  })

  return createApiResponse(userSkill)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'user-skills:update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const id = pathParts[pathParts.length - 3]
  const skillId = pathParts[pathParts.length - 1]

  if (!id || !skillId) {
    return createApiError('User ID and Skill ID required', 400)
  }

  if (id !== user.id && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  await prisma.userSkill.delete({
    where: { userId_skillId: { userId: id, skillId } }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'user-skills:delete' } })