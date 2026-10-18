import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { sendRomanceSpark } from '@/lib/romance/sparks'
import { getRomanceMatch } from '@/lib/romance/matches'

const bodySchema = z
  .object({
    toId: z.string().min(1).max(64),
    // Length and quality are judged by the opener rules (src/lib/matching/opener.ts) so that the refusal says why.
    opener: z.string().max(2000),
    dropId: z.string().min(1).max(64).optional(),
  })
  .strict()

// Sends a romance spark: to this week's drop, or in answer to a spark waiting for the caller. If the person had already sparked the caller the two are matched in the same request.
// The caller must have joined, pass the 18+ gate and be a trusted account; the person must be somebody both people's private filters allow. Creating, so it honours Idempotency-Key.
// Sparks and matches pay no XP, and a romance match counts toward no achievement.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const result = await sendRomanceSpark(prisma, user.id, body.data)
  if (!result.ok) return createApiError(result.code, { params: result.params, details: result.details })

  const match = result.match ? await getRomanceMatch(prisma, user.id, result.match.id) : null
  return createApiResponse(
    {
      spark: { id: result.spark.id, toId: result.spark.toId, opener: result.spark.opener, status: result.spark.status, createdAt: result.spark.createdAt.toISOString() },
      match,
    },
    201
  )
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:spark-create' } })
