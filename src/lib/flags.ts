import type { PrismaClient } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'
import { log } from '@/lib/log'
import { isLaunchGateFlag } from '@/lib/romance/launch-keys'

// Feature flags: switches that can be changed at runtime, without a deploy.
// A flag is on for a user when
//   1. the user is on its allowlist (works even while the flag is off, for
//      early access), or
//   2. the flag is enabled and the user falls inside its rollout: 100% is
//      everyone, anything lower is a stable share of users.
// Otherwise it is off. A flag that does not exist is off.
//
// "A stable share" means a user keeps their answer as the percentage grows: the
// ones in at 10% are still in at 20%. It comes from a hash of the flag key and
// the user id, so it does not depend on when or where the check runs, and two
// flags roll out to different users.

export interface FlagRecord {
  key: string
  enabled: boolean
  rolloutPercent: number
  allowUserIds: string[]
}

export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/

/** FNV-1a, 32 bits: small, dependency-free and the same everywhere. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** The user's place in this flag's rollout: 0 to 99. */
export function rolloutBucket(key: string, userId: string): number {
  return fnv1a(`${key}:${userId}`) % 100
}

export function evaluateFlag(flag: FlagRecord | null | undefined, userId: string | null | undefined): boolean {
  if (!flag) return false
  if (userId && flag.allowUserIds.includes(userId)) return true
  if (!flag.enabled) return false
  if (flag.rolloutPercent >= 100) return true
  if (flag.rolloutPercent <= 0 || !userId) return false
  return rolloutBucket(flag.key, userId) < flag.rolloutPercent
}

// --- Loading -------------------------------------------------------------------
// Flags are read on many requests and change rarely, so the whole set is cached
// for a short time. Changes made through the admin API drop the cache entry, which
// on Redis reaches every instance at once; the TTL is the upper bound otherwise.

export const FLAGS_CACHE_KEY = 'flags:all'
export const FLAGS_CACHE_TTL_MS = 30_000

type FlagDb = Pick<PrismaClient, 'featureFlag'>

function toRecord(row: { key: string; enabled: boolean; rolloutPercent: number; allowUserIds: string[] }): FlagRecord {
  return { key: row.key, enabled: row.enabled, rolloutPercent: row.rolloutPercent, allowUserIds: row.allowUserIds }
}

export async function loadFlags(db: FlagDb, cache: Cache = getCache()): Promise<FlagRecord[]> {
  try {
    const cached = await cache.get(FLAGS_CACHE_KEY)
    if (cached) return JSON.parse(cached) as FlagRecord[]
  } catch (error) {
    log.warn('flag cache read failed; reading the database', { error })
  }

  const rows = await db.featureFlag.findMany({ select: { key: true, enabled: true, rolloutPercent: true, allowUserIds: true } })
  const flags = rows.map(toRecord)
  try {
    await cache.set(FLAGS_CACHE_KEY, JSON.stringify(flags), { ttlMs: FLAGS_CACHE_TTL_MS })
  } catch (error) {
    log.warn('flag cache write failed', { error })
  }
  return flags
}

export async function invalidateFlags(cache: Cache = getCache()): Promise<void> {
  try {
    await cache.del(FLAGS_CACHE_KEY)
  } catch (error) {
    log.warn('flag cache invalidation failed; changes show up when the entry expires', { error })
  }
}

export async function isEnabled(db: FlagDb, key: string, userId: string | null | undefined, cache?: Cache): Promise<boolean> {
  const flags = await loadFlags(db, cache)
  return evaluateFlag(flags.find((flag) => flag.key === key), userId)
}

/**
 * Every flag with the answer for this user, for the interface to read in one call. The flags that gate the romance mode (its launch flags and its kill switch) are left out: the
 * interface learns whether the mode is open from GET /api/romance/interest, and a closed mode appears in no list.
 */
export async function flagsFor(db: FlagDb, userId: string | null | undefined, cache?: Cache): Promise<Record<string, boolean>> {
  const flags = await loadFlags(db, cache)
  return Object.fromEntries(flags.filter((flag) => !isLaunchGateFlag(flag.key)).map((flag) => [flag.key, evaluateFlag(flag, userId)]))
}
