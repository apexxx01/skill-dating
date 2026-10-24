import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { updateUserSkillSchema } from './schema'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const id = pathParts[pathParts.length - 3]
  const skillId = pathParts[pathParts.length - 1]

  if (!id || !skillId) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'userId, skillId' } })
  }

  if (id !== user.id && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  const bodyResult = await validateBody(updateUserSkillSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const existing = await prisma.userSkill.findUnique({
    where: { userId_skillId: { userId: id, skillId } }
  })
  if (!existing) {
    return createApiError('USER_SKILL_NOT_FOUND')
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
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'userId, skillId' } })
  }

  if (id !== user.id && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  await prisma.userSkill.delete({
    where: { userId_skillId: { userId: id, skillId } }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'user-skills:delete' } })