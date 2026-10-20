import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { proposalFor } from '@/lib/squads/builder'

// GET /api/squad-proposals/{id}: one proposal (members, roles, reasons and strength), for the person who asked for it or anyone on it.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop()
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'proposalId' } })
  const proposal = await proposalFor(prisma, id, user.id)
  if (!proposal) return createApiError('SQUAD_PROPOSAL_NOT_FOUND')
  return createApiResponse({ proposal })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'squad-proposals:get' } })
