import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { toMatchItem } from '@/lib/matching/matches'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { sendSpark } from '@/lib/matching/sparks'
import type { MatchTypeName, SendSparkResponse } from '@/types/api'
import { bodySchema } from './schema'

// Sends a spark. If the person had already sparked the caller (for the counterpart type) the two are matched in the same request: the response then
// carries the match. Creating, so it honours Idempotency-Key. Sparks and matches pay no XP.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const result = await sendSpark(prisma, user.id, body.data)
  if (!result.ok) return createApiError(result.code, { params: result.params, details: result.details })

  let match: SendSparkResponse['match'] = null
  if (result.match) {
    const other = (await loadPersonSummaries(prisma, [body.data.toId])).get(body.data.toId)
    if (other) match = toMatchItem(result.match, user.id, other)
  }
  const response: SendSparkResponse = {
    spark: {
      id: result.spark.id,
      toId: result.spark.toId,
      connectionType: result.spark.connectionType as MatchTypeName,
      opener: result.spark.opener,
      status: result.spark.status,
      createdAt: result.spark.createdAt.toISOString(),
    },
    match,
  }
  return createApiResponse(response, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'sparks:create' } })
