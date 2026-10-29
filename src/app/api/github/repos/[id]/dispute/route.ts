import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { fileClaimDispute } from '@/lib/evidence/disputes'
import { disputeSchema } from './schema'

// POST /api/github/repos/{id}/dispute: contest another person's claim to a repository the caller has authored work in ({id} is that person's claim, as
// GET /api/github lists it under otherClaims). Files a CLAIM_DISPUTE report into the moderation queue; a moderator who upholds it hides the claim
// (HIDE_CONTENT on EVIDENCE_CLAIM: audited, and appealable by its owner through POST /api/appeals). **Body:** `{ description }` (10 to 2000 characters).
// **Response `201`:** `{ report: { id, status, priority } }`. **Errors:** `404 CLAIM_NOT_FOUND`, `400 CANNOT_REPORT_SELF`, `403 DISPUTE_NOT_ALLOWED` (no
// authored work of the caller's there), `409 REPORT_ALREADY_PENDING`, `503 EVIDENCE_ENGINE_PAUSED`. Honours Idempotency-Key.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(disputeSchema)(request)
  if (body instanceof Response) return body
  const outcome = await fileClaimDispute(prisma, user.id, id, body.data.description)
  if (!outcome.ok) return createApiError(outcome.code, outcome.details ? { details: outcome.details } : undefined)
  return createApiResponse({ report: { id: outcome.report.id, status: outcome.report.status, priority: outcome.report.priority } }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 5, keyPrefix: 'github:dispute' } })
