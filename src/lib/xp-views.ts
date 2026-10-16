import { getCache, type Cache } from '@/lib/infra/cache'
import { recordBoardXp } from '@/lib/leaderboard-write'
import { log } from '@/lib/log'

// Everything derived from a user's XP that is kept somewhere other than the XPEvent table:
// the player card and the heatmap are cached, and the leaderboards live in Redis.
// grant() calls onXpEarned() after the transaction that paid the XP has committed, so none of
// this ever shows XP that was rolled back, and a failure here cannot fail the request that
// earned it: the nightly reconcile and the cache lifetimes repair whatever was missed.

export const STATS_TTL_MS = 60_000
export const HEATMAP_TTL_MS = 10 * 60_000

export const statsCacheKey = (userId: string) => `stats:${userId}`
/** Bumped on every award; part of every heatmap cache key, so a bump retires all of a user's cached heatmaps at once. */
export const heatmapVersionKey = (userId: string) => `heatmap:v:${userId}`

export async function invalidateUserViews(userId: string, cache: Cache = getCache()): Promise<void> {
  await Promise.all([cache.del(statsCacheKey(userId)), cache.incr(heatmapVersionKey(userId))])
}

export interface XpEarned {
  userId: string
  amount: number
  at: Date
  seasonId: string | null
}

export async function onXpEarned(earned: XpEarned, cache: Cache = getCache()): Promise<void> {
  try {
    await invalidateUserViews(earned.userId, cache)
  } catch (error) {
    log.warn('could not refresh the views of a user after an award', { error, userId: earned.userId })
  }
  try {
    // The database is loaded here, not at the top of the file, so modules that only want the cache keys stay light.
    const { prisma } = await import('@/lib/prisma')
    await recordBoardXp(prisma, cache, earned)
  } catch (error) {
    // The nightly rebuild (leaderboards/reconcile) repairs a board that missed an award.
    log.warn('could not add an award to the leaderboards', { error, userId: earned.userId })
  }
}
