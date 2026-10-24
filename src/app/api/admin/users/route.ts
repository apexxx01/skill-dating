import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { effectiveLevel } from '@/lib/integrity/risk'
import { querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const { q, limit } = query.data
  const admin = user.role === 'ADMIN'
  const byEmail = q.includes('@')
  if (byEmail && !admin) return createApiError('FORBIDDEN')

  const where: Prisma.UserWhereInput = byEmail
    ? { email: { equals: q.toLowerCase(), mode: 'insensitive' } }
    : { OR: [{ id: q }, { username: { equals: q.toLowerCase() } }, { username: { startsWith: q.toLowerCase() } }] }
  const rows = await prisma.user.findMany({
    where,
    take: limit,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      deletedAt: true,
      isEmailVerified: true,
      verificationLevel: true,
      organizationVerified: true,
      risk: true,
      restrictions: { where: { liftedAt: null }, select: { kind: true, endsAt: true } },
    },
  })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'ADMIN_USER_LOOKUP', targetType: 'USER', newValue: { by: byEmail ? 'email' : 'id-or-username', results: rows.length } } })
  return createApiResponse({
    users: rows.map(({ email, risk, ...row }) => ({ ...row, ...(admin ? { email } : {}), risk: { score: risk?.score ?? 0, effectiveLevel: effectiveLevel(risk) } })),
  })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:users' } })
