import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { inviteProposal } from '@/lib/squads/builder'

// POST /api/hackathons/{id}/squad-builder/{proposalId}/invite: turns the caller's proposal into a team (theirs, or a new one) and a 48-hour slot
// invitation for every proposed person who is still free, in one call. A proposal is used once; send an Idempotency-Key to retry safely.
const bodySchema = z.object({ teamName: z.string().trim().min(1).max(100).optional() }).strict()

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parts = new URL(request.url).pathname.split('/')
  const hackathonId = parts.slice(-4)[0]
  const proposalId = parts.slice(-2)[0]
  if (!hackathonId || !proposalId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId, proposalId' } })

  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const owned = await prisma.squadProposal.findUnique({ where: { id: proposalId }, select: { hackathonId: true } })
  if (!owned || owned.hackathonId !== hackathonId) return createApiError('SQUAD_PROPOSAL_NOT_FOUND')

  const result = await inviteProposal(prisma, { proposalId, requesterId: user.id, teamName: body.data.teamName })
  if (!result.ok) return createApiError(result.code, result.params ? { params: result.params } : undefined)
  return createApiResponse(result.outcome, result.outcome.created ? 201 : 200)
}, { idempotent: true, rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 20, keyPrefix: 'hackathons:squad-invite' } })
