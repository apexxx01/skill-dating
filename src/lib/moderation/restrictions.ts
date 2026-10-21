import type { Prisma, PrismaClient, RestrictionKind } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'

// What moderation has closed for a person right now: a suspension, a ban, or one feature (romance, messaging, posting). Read on every request by the
// request gate (src/lib/api/gate.ts), so it is cached per person for a minute and dropped by every change (an action, a reversal, an appeal).

type Db = PrismaClient | Prisma.TransactionClient

export type RestrictedFeature = 'romance' | 'messaging' | 'posting'

export const FEATURE_OF_KIND: Partial<Record<RestrictionKind, RestrictedFeature>> = { ROMANCE: 'romance', MESSAGING: 'messaging', POSTING: 'posting' }
export const KIND_OF_FEATURE: Record<RestrictedFeature, RestrictionKind> = { romance: 'ROMANCE', messaging: 'MESSAGING', posting: 'POSTING' }

export interface AccountState {
  suspendedUntil: string | null
  banned: boolean
  /** Feature restrictions in force, each with its end (null: until lifted). */
  restricted: Partial<Record<RestrictedFeature, string | null>>
}

const EMPTY: AccountState = { suspendedUntil: null, banned: false, restricted: {} }
const TTL_MS = 60_000
const keyOf = (userId: string) => `account-state:${userId}`

/** Pure: the state from the restriction rows in force at `now`. */
export function stateFrom(rows: readonly { kind: RestrictionKind; endsAt: Date | null; liftedAt: Date | null }[], now: Date): AccountState {
  const state: AccountState = { suspendedUntil: null, banned: false, restricted: {} }
  for (const row of rows) {
    if (row.liftedAt || (row.endsAt && row.endsAt.getTime() <= now.getTime())) continue
    if (row.kind === 'BANNED') state.banned = true
    else if (row.kind === 'SUSPENDED') {
      // An open-ended suspension is reported as the far future; the longest one wins.
      const until = (row.endsAt ?? new Date('9999-12-31T00:00:00Z')).toISOString()
      if (!state.suspendedUntil || until > state.suspendedUntil) state.suspendedUntil = until
    } else {
      const feature = FEATURE_OF_KIND[row.kind]!
      const until = row.endsAt?.toISOString() ?? null
      const current = state.restricted[feature]
      state.restricted[feature] = current === undefined ? until : current === null || until === null ? null : until > current ? until : current
    }
  }
  return state
}

export async function accountState(db: Db, userId: string, cache: Cache = getCache(), now: Date = new Date()): Promise<AccountState> {
  try {
    const cached = await cache.get(keyOf(userId))
    if (cached) return JSON.parse(cached) as AccountState
  } catch {
    // read the database
  }
  const rows = await db.userRestriction.findMany({ where: { userId, liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, select: { kind: true, endsAt: true, liftedAt: true } })
  const state = rows.length === 0 ? EMPTY : stateFrom(rows, now)
  // Cached for a minute at most, and never past the moment the first restriction ends.
  const ends = rows.map((row) => row.endsAt?.getTime()).filter((t): t is number => typeof t === 'number')
  const ttl = Math.max(1000, Math.min(TTL_MS, ...ends.map((t) => t - now.getTime())))
  await cache.set(keyOf(userId), JSON.stringify(state), { ttlMs: ttl }).catch(() => undefined)
  return state
}

export async function invalidateAccountState(userId: string, cache: Cache = getCache()): Promise<void> {
  await cache.del(keyOf(userId)).catch(() => undefined)
}
