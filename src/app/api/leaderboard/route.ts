import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam } from '@/lib/api/pagination'
import { blockedPeerIds } from '@/lib/blocks'
import { BOARD_PERIODS, BOARD_SCOPES, parseScopeId, type CachedScope } from '@/lib/leaderboard-boards'
import { readLeaderboard } from '@/lib/leaderboard-read'
import { isValidId } from '@/lib/progress'

const querySchema = z.object({
  period: z.enum(BOARD_PERIODS).default('all-time'),
  scope: z.enum(BOARD_SCOPES).default('global'),
  // "IN", "IN:bengaluru", a campus, or a team id: see LeaderboardResponse. Absent: the caller's own place.
  scopeId: z.string().trim().min(1).max(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorParam,
})

// Ranks come from sorted sets in the cache (src/lib/leaderboard-write.ts keeps them current, a nightly job
// rebuilds them from the XP log), not from summing the log per request. Blocked people, in either direction, are
// left out and ranks are counted over who is left, so the page is consecutive for this viewer. People
// who switched leaderboards off are on no board. The period and scope are chosen with `period` and `scope`.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const { period, scope, scopeId: rawScopeId, page, limit, cursor } = query.data
  if (!period || !scope) return createApiError('VALIDATION_FAILED')

  // A given scope id must be well formed for its scope; an absent one means "mine".
  let scopeId: string | null = null
  if (rawScopeId !== undefined && scope !== 'global') {
    scopeId = scope === 'crew' ? (isValidId(rawScopeId) ? rawScopeId : null) : parseScopeId(scope as CachedScope, rawScopeId)
    if (!scopeId) return createApiError('VALIDATION_FAILED', { details: { scopeId: [`Not a valid ${scope} id`] } })
  }

  const blocked = await blockedPeerIds(prisma, user.id)
  const outcome = await readLeaderboard(prisma, { viewerId: user.id, period, scope, scopeId, cursor, page: page ?? 1, limit: limit ?? 50, blocked })
  switch (outcome.kind) {
    case 'invalid-cursor':
      return createApiError('INVALID_CURSOR')
    case 'scope-missing':
      return createApiError('VALIDATION_FAILED', {
        details: { scopeId: [outcome.scope === 'crew' ? 'Name the crew with scopeId' : `You have not set your ${outcome.scope}; set it on your profile or pass scopeId`] },
      })
    case 'crew-not-found':
      return createApiError('TEAM_NOT_FOUND')
    case 'ok':
      return createApiResponse(outcome.data)
  }
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'leaderboard:get' } })
