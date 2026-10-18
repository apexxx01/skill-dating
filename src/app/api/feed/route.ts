import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { feedQuerySchema, loadFeed } from '@/lib/feed/feed'

// The feed: for-you (everyone, ranked), following (people you follow and projects you watch), city, campus. Ranking v1 and the paging rules are in docs/FEED.md. Blocked and hidden posts never appear,
// and no author fills more than two places on a page. The cursor is opaque and fixes the moment the ranking is judged at, so a page never repeats or skips a post while you scroll.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(feedQuerySchema)(request)
  if (query instanceof Response) return query
  const feed = await loadFeed(prisma, user.id, query.data)
  if (feed === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  return createApiResponse(feed)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'feed' } })
