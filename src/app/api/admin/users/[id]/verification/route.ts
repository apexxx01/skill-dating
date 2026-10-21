import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { requireRecentAuth } from '@/lib/api/recent-auth'
import { setAdminMarks } from '@/lib/admin-verification'

// PATCH /api/admin/users/{id}/verification { organizationVerified?, portfolioVerified?, identityVerified?, reason }: grants or takes back a mark only an
// admin can give (the verified-organisation mark among them). The level follows. Needs a session signed in within the last 10 minutes. Audited. Admins only.
const bodySchema = z
  .object({ organizationVerified: z.boolean(), portfolioVerified: z.boolean(), identityVerified: z.boolean() })
  .partial()
  .extend({ reason: z.string().trim().min(3).max(1000) })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'Change at least one mark')

export const PATCH = withAuth(async (request: NextRequest, { prisma, user, session }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const reauth = await requireRecentAuth(session)
  if (reauth) return reauth
  const { reason, ...marks } = body.data
  const updated = await setAdminMarks(prisma, { userId: id, adminId: user.id, marks, reason })
  if (!updated) return createApiError('USER_NOT_FOUND')
  return createApiResponse({ userId: id, ...updated })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:verification' } })
