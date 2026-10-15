import type { PrismaClient } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'
import { track } from '@/lib/infra/analytics'
import { log } from '@/lib/log'

// Onboarding is complete once the profile has a headline and at least one skill
// (the same rule GET /api/users/me reports and the middleware acts on). The product
// event `onboarding_completed` is recorded the first time that becomes true.
// Whatever sets either half of it calls this afterwards.

const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000

type Db = Pick<PrismaClient, 'user' | 'userSkill' | 'productEvent'>

/** Records onboarding_completed once per user, and only when onboarding really is complete. Never throws. */
export async function trackOnboardingIfComplete(db: Db, userId: string, cache: Cache = getCache()): Promise<boolean> {
  try {
    const [row, skillCount] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { headline: true } }),
      db.userSkill.count({ where: { userId } }),
    ])
    if (!row?.headline || skillCount === 0) return false

    // Two requests can finish onboarding at once; the atomic counter lets one of them record it.
    if ((await cache.incr(`onboarding-tracked:${userId}`, { ttlMs: CLAIM_TTL_MS })) !== 1) return false

    // The table is the record of what was tracked, and outlives the cache.
    const already = await db.productEvent.findFirst({ where: { userId, name: 'onboarding_completed' }, select: { id: true } })
    if (already) return false

    await track(userId, 'onboarding_completed')
    return true
  } catch (error) {
    log.warn('could not record onboarding_completed', { error })
    return false
  }
}
