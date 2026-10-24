import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockedPeerIds } from '@/lib/blocks'
import { parseScopeId, type CachedScope } from '@/lib/leaderboard-boards'
import { readLeaderboard } from '@/lib/leaderboard-read'
import { isValidId } from '@/lib/progress'
import { querySchema } from './schema'

// Ranks come from sorted sets in the cache (src/lib/leaderboard-write.ts keeps them current, a nightly job
// rebuilds them from the XP log), not from summing the log per request. Blocked people, in either direction, are
// left out of the viewer's list but keep their place: a rank is the same number for every viewer, so a page can skip
// one. People who switched leaderboards off are on no board. The period and scope are chosen with `period` and `scope`.
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
}, { cache: { maxAge: 30 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'leaderboard:get' } })
