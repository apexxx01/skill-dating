import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { requireRecentAuth } from '@/lib/api/recent-auth'

// PUT /api/admin/users/{id}/plan { plan, until?, reason }: an entitlement override (a comped plan, a correction after a billing problem). It writes the
// person's Subscription with provider "admin", so a later billing integration can tell it apart. Admins only, with a session signed in within the last
// 10 minutes. Audited with the old and the new plan.
const bodySchema = z
  .object({ plan: z.enum(['FREE', 'PRO', 'CREW_PRO', 'ORG']), until: z.string().max(40).datetime().optional(), reason: z.string().trim().min(3).max(1000) })
  .strict()

export const PUT = withAuth(async (request: NextRequest, { prisma, user, session }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const reauth = await requireRecentAuth(session)
  if (reauth) return reauth
  if (!(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) return createApiError('USER_NOT_FOUND')
  const before = await prisma.subscription.findUnique({ where: { userId: id }, select: { plan: true, status: true, currentPeriodEnd: true, provider: true } })
  const data = { plan: body.data.plan, status: 'ACTIVE' as const, currentPeriodEnd: body.data.until ? new Date(body.data.until) : null, provider: 'admin', providerRef: user.id }
  const after = await prisma.subscription.upsert({ where: { userId: id }, create: { userId: id, ...data }, update: data, select: { plan: true, status: true, currentPeriodEnd: true, provider: true } })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'ENTITLEMENT_OVERRIDDEN', targetType: 'USER', targetId: id, oldValue: before ?? undefined, newValue: { ...after, reason: body.data.reason } } })
  return createApiResponse({ userId: id, ...after })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:plan' } })
