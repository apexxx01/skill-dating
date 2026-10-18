import type { PrismaClient } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'
import { track } from '@/lib/infra/analytics'
import { env } from '@/lib/env'
import { log } from '@/lib/log'

// Onboarding is complete once the profile has a headline, at least one skill and (while BIRTH_DATE_REQUIRED is on, the default) a date of birth on file
// (the same rule GET /api/users/me reports and the middleware acts on). The product
// event `onboarding_completed` is recorded the first time that becomes true.
// Whatever sets any part of it calls this afterwards.

const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface OnboardingFacts {
  headline: string | null | undefined
  skillCount: number
  hasBirthDate: boolean
}

/** Whether the three parts of onboarding are done. `birthDateRequired` is the BIRTH_DATE_REQUIRED setting. */
export function isOnboardingComplete(facts: OnboardingFacts, birthDateRequired: boolean): boolean {
  return Boolean(facts.headline) && facts.skillCount > 0 && (!birthDateRequired || facts.hasBirthDate)
}

type Db = Pick<PrismaClient, 'user' | 'userSkill' | 'productEvent'>

/** Records onboarding_completed once per user, and only when onboarding really is complete. Never throws. */
export async function trackOnboardingIfComplete(db: Db, userId: string, cache: Cache = getCache()): Promise<boolean> {
  try {
    const [row, skillCount] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { headline: true, birthDate: true } }),
      db.userSkill.count({ where: { userId } }),
    ])
    if (!isOnboardingComplete({ headline: row?.headline, skillCount, hasBirthDate: Boolean(row?.birthDate) }, env.BIRTH_DATE_REQUIRED)) return false

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
