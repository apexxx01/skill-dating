import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { addExternalHackathon, externalHackathonSchema, isUnverified } from '@/lib/squads/external-create'
import { accountDistrust } from '@/lib/trust'

// POST /api/hackathons/external: a trusted user adds a hackathon that lives on another platform (Devfolio, Devpost, MLH, Unstop, Luma...) by its
// link, so squads can form for it here. Deduplicated by the normalised link: the same page twice is the same hackathon (200, `created: false`).
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { createdAt: true, isEmailVerified: true } })
  if (accountDistrust(account)) return createApiError('ACCOUNT_NOT_TRUSTED')

  const body = await validateBody(externalHackathonSchema)(request)
  if (body instanceof Response) return body

  const result = await addExternalHackathon(prisma, { submitterId: user.id, body: body.data })
  if (!result.ok) {
    if (result.code === 'EXTERNAL_PAGE_UNREADABLE') return createApiError(result.code, { params: { reason: result.reason ?? 'unknown' } })
    if (result.code === 'VALIDATION_FAILED') return createApiError(result.code, { details: { [result.reason ?? 'url']: ['Missing or invalid'] } })
    return createApiError(result.code, result.reason ? { details: { reason: result.reason } } : undefined)
  }
  const hackathon = await prisma.hackathon.findUniqueOrThrow({ where: { id: result.hackathonId } })
  return createApiResponse({ hackathon: { ...hackathon, unverified: isUnverified(hackathon) }, created: result.created }, result.created ? 201 : 200)
}, { idempotent: true, rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 10, keyPrefix: 'hackathons:external' } })
