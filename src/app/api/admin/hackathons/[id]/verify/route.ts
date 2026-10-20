import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isUnverified } from '@/lib/squads/external-create'

// PATCH /api/admin/hackathons/{id}/verify { verified }: an admin vouches for an external hackathon (it then pays XP like a native one), or takes
// that back. Native hackathons are always verified.
const bodySchema = z.object({ verified: z.boolean() }).strict()

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const current = await prisma.hackathon.findUnique({ where: { id }, select: { source: true } })
  if (!current) return createApiError('HACKATHON_NOT_FOUND')
  if (current.source !== 'EXTERNAL') return createApiError('VALIDATION_FAILED', { details: { verified: ['Only an external hackathon is verified'] } })

  const hackathon = await prisma.hackathon.update({ where: { id }, data: { verifiedAt: body.data.verified ? new Date() : null } })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'HACKATHON_VERIFIED', targetType: 'HACKATHON', targetId: id, newValue: { verified: body.data.verified } as Prisma.InputJsonValue } })
  return createApiResponse({ id, verifiedAt: hackathon.verifiedAt, unverified: isUnverified(hackathon) })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:hackathon-verify' } })
