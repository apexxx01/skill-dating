import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { proposalFor } from '@/lib/squads/builder'
import { respondToProposal } from '@/lib/squads/pool'

// POST /api/squad-proposals/{id}/respond { accept }: a member's answer to a squad the solo pool proposed. The squad forms (or fails) as soon as
// everybody has answered, else when its day is up.
const bodySchema = z.object({ accept: z.boolean() }).strict()

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'proposalId' } })

  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const result = await respondToProposal(prisma, { proposalId: id, userId: user.id, accept: body.data.accept })
  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') return createApiError('SQUAD_PROPOSAL_NOT_FOUND')
    if (result.reason === 'EXPIRED') return createApiError('SQUAD_PROPOSAL_EXPIRED')
    return createApiError('SQUAD_PROPOSAL_USED')
  }
  return createApiResponse({ status: result.status, teamId: result.teamId, proposal: await proposalFor(prisma, id, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'squad-proposals:respond' } })
