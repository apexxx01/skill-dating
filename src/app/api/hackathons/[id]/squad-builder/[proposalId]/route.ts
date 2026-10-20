import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { proposalFor } from '@/lib/squads/builder'

// GET /api/hackathons/{id}/squad-builder/{proposalId}: a proposal again, for the person who asked for it or anyone on it.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parts = new URL(request.url).pathname.split('/')
  const hackathonId = parts.slice(-3)[0]
  const proposalId = parts.pop()
  if (!hackathonId || !proposalId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId, proposalId' } })

  const proposal = await proposalFor(prisma, proposalId, user.id)
  if (!proposal || proposal.hackathonId !== hackathonId) return createApiError('SQUAD_PROPOSAL_NOT_FOUND')
  return createApiResponse({ proposal })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'hackathons:squad-proposal' } })
