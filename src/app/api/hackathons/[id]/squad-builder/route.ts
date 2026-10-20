import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { proposeSquad } from '@/lib/squads/builder'
import { MAX_SEED } from '@/lib/squads/optimizer'

// POST /api/hackathons/{id}/squad-builder ("Find my squad"): a complete squad of a sensible size proposed around the caller, from the hackathon's solo
// pool, with each person's role and reasons and the squad's strength (docs/SQUADS.md, "The squad builder"). The proposal is kept for 24 hours for
// the invite step. Deterministic for a seed; bounded work.
const bodySchema = z
  .object({
    size: z.number().int().min(1).max(10).optional(),
    seed: z.number().int().min(0).max(MAX_SEED).optional(),
    tracks: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
  })
  .strict()

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })

  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const result = await proposeSquad(prisma, { hackathonId: id, requesterId: user.id, ...body.data })
  if (!result.ok) return createApiError(result.code, result.params ? { params: result.params } : undefined)
  return createApiResponse({ proposal: result.proposal }, 201)
}, { rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 20, keyPrefix: 'hackathons:squad-builder' } })
