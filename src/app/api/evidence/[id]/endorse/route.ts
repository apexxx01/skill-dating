import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { endorseEvidence, unendorseEvidence } from '@/lib/skill-evidence'

function evidenceIdFrom(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/').slice(-2)[0]
}

// 201 the first time, 200 on every repeat: the caller can tell whether this
// call created the endorsement, and repeating it is always safe.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const evidenceId = evidenceIdFrom(request)
  if (!evidenceId) return createApiError('Evidence ID required', 400)

  const result = await endorseEvidence(prisma, {
    endorserId: user.id,
    endorserName: user.name || user.username || 'Someone',
    evidenceId,
  })

  if (result.outcome === 'not_found') return createApiError('Evidence not found', 404)
  if (result.outcome === 'self') return createApiError('You cannot endorse your own evidence', 403)

  return createApiResponse(
    { endorsed: true, endorsementCount: result.endorsementCount },
    result.outcome === 'created' ? 201 : 200
  )
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'evidence:endorse' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const evidenceId = evidenceIdFrom(request)
  if (!evidenceId) return createApiError('Evidence ID required', 400)

  const result = await unendorseEvidence(prisma, { endorserId: user.id, evidenceId })
  if (result.outcome === 'not_found') return createApiError('Evidence not found', 404)

  return createApiResponse({ endorsed: false, endorsementCount: result.endorsementCount })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'evidence:unendorse' } })
