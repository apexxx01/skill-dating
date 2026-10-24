import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { effectiveLevel } from '@/lib/integrity/risk'
import { overrideRisk } from '@/lib/integrity/risk-job'
import { bodySchema } from './schema'

const userIdOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0]

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const id = userIdOf(request)
  if (!(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) return createApiError('USER_NOT_FOUND')
  const risk = await prisma.userRisk.findUnique({ where: { userId: id } })
  return createApiResponse({
    userId: id,
    score: risk?.score ?? 0,
    level: risk?.level ?? 'LOW',
    overrideLevel: risk?.overrideLevel ?? null,
    effectiveLevel: effectiveLevel(risk),
    factors: risk?.factors ?? {},
    computedAt: risk?.computedAt ?? null,
  })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:risk-get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = userIdOf(request)
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  if (!(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) return createApiError('USER_NOT_FOUND')
  const risk = await overrideRisk(prisma, { userId: id, level: body.data.level, reason: body.data.reason, adminId: user.id })
  return createApiResponse({ userId: id, score: risk.score, level: risk.level, overrideLevel: risk.overrideLevel, effectiveLevel: effectiveLevel(risk) })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:risk-override' } })
