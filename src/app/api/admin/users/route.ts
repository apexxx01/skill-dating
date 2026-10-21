import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { effectiveLevel } from '@/lib/integrity/risk'

// GET /api/admin/users?q=: find a person by id, username (exact, then prefix) or e-mail. Searching by e-mail, and seeing e-mail addresses, is for admins
// only (403 FORBIDDEN for a moderator). Each result carries the role, verification, risk and restrictions in force. Staff only; every search is audited.
const querySchema = z.object({ q: z.string().trim().min(2).max(200), limit: z.coerce.number().int().min(1).max(25).default(10) })

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
