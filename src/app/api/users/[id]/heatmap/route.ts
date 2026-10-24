import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockRelation } from '@/lib/blocks'
import { heatmapRange, loadHeatmap, MAX_HEATMAP_DAYS } from '@/lib/heatmap'
import { getCache } from '@/lib/infra/cache'
import { isValidId } from '@/lib/progress'
import { HEATMAP_TTL_MS, heatmapVersionKey } from '@/lib/xp-views'
import type { HeatmapDay, HeatmapResponse } from '@/types/api'
import { querySchema } from './schema'

// GET /api/users/{id}/heatmap?days=365
//
// Anyone signed in can read it, except: the person is gone, or has blocked the viewer (both look
// like a missing user), or has turned "show activity" off (everyone but themselves then gets an
// empty heatmap marked `hidden`). The grouping uses the OWNER's time zone. The answer is cached
// for 10 minutes; grant() retires every cached heatmap of a user by bumping their version, so a
// new award shows at once. The cache holds only the days, never anything viewer-specific.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/')[3]
  if (!isValidId(id)) return createApiError('USER_NOT_FOUND')

  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const days = query.data.days ?? MAX_HEATMAP_DAYS

  const owner = await prisma.user.findUnique({
    where: { id },
    select: { timezone: true, deletedAt: true, profile: { select: { showActivity: true } } },
  })
  if (!owner || owner.deletedAt) return createApiError('USER_NOT_FOUND')
  // The person who blocked can still open the profile (to unblock); the blocked person cannot see it.
  if ((await blockRelation(prisma, user.id, id)) === 'BLOCKED_BY_THEM') return createApiError('USER_NOT_FOUND')

  const range = heatmapRange(days, owner.timezone)
  const base = { timezone: range.timezone, days, from: range.from, to: range.to }

  if (id !== user.id && owner.profile?.showActivity === false) {
    return createApiResponse<HeatmapResponse>({ ...base, hidden: true, items: [] })
  }

  const cache = getCache()
  const version = (await cache.get(heatmapVersionKey(id))) ?? '0'
  const key = `heatmap:${id}:${version}:${days}`
  const cached = await cache.get(key)
  if (cached) return createApiResponse<HeatmapResponse>({ ...base, hidden: false, items: JSON.parse(cached) as HeatmapDay[] })

  const items = await loadHeatmap(prisma, id, range)
  await cache.set(key, JSON.stringify(items), { ttlMs: HEATMAP_TTL_MS })
  return createApiResponse<HeatmapResponse>({ ...base, hidden: false, items })
}, { cache: { maxAge: 60 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:heatmap' } })
