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
  if (!evidenceId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'evidenceId' } })

  const result = await endorseEvidence(prisma, {
    endorserId: user.id,
    endorserName: user.name || user.username || 'Someone',
    evidenceId,
  })

  if (result.outcome === 'not_found') return createApiError('EVIDENCE_NOT_FOUND')
  if (result.outcome === 'self') return createApiError('CANNOT_ENDORSE_OWN_EVIDENCE')
  if (result.outcome === 'blocked_by_me') return createApiError('USER_BLOCKED')
  // Being blocked is not revealed: to the blocked user the evidence simply does not exist.
  if (result.outcome === 'blocked_by_them') return createApiError('EVIDENCE_NOT_FOUND')

  return createApiResponse(
    { endorsed: true, endorsementCount: result.endorsementCount },
    result.outcome === 'created' ? 201 : 200
  )
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'evidence:endorse' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const evidenceId = evidenceIdFrom(request)
  if (!evidenceId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'evidenceId' } })

  const result = await unendorseEvidence(prisma, { endorserId: user.id, evidenceId })
  if (result.outcome === 'not_found') return createApiError('EVIDENCE_NOT_FOUND')

  return createApiResponse({ endorsed: false, endorsementCount: result.endorsementCount })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'evidence:unendorse' } })
