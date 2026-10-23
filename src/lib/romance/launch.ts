import type { PrismaClient } from '@prisma/client'
import { evaluateFlag, FLAG_KEY_PATTERN, loadFlags, type FlagRecord } from '@/lib/flags'
import type { Cache } from '@/lib/infra/cache'
import { isLaunchGateFlag, ROMANCE_CITY_FLAG_PREFIX, ROMANCE_KILL_FLAG, ROMANCE_LAUNCH_FLAG } from '@/lib/romance/launch-keys'
import { log } from '@/lib/log'

// The romance mode ships CLOSED (docs/ROMANCE.md, "Launch"). It is open for a person only when
//   1. the kill switch `kill.romance` is off, and
//   2. the flag `romance.enabled` is on for them (enabled and inside its rollout, or on its allowlist), or the flag of their city is:
//      `romance.city.<country>-<city>`, for example `romance.city.in-pune` (the profile's country code and city key, lower case).
// All of them are feature flags, created off by the migration (the city ones by an admin), changed with PATCH /api/admin/flags/{key} and audited like any flag. A flag that does
// not exist is off, so a fresh environment is closed. A person with no city is covered by `romance.enabled` only.
//
// While it is closed every romance route answers `503 ROMANCE_PAUSED` (the request gate, src/lib/api/gate.ts), the mode is left out of the consent and notification lists, and its jobs
// do nothing. Asking to be told when it opens is the one thing that works (src/lib/romance/interest.ts).

export { ROMANCE_LAUNCH_FLAG, ROMANCE_CITY_FLAG_PREFIX, isLaunchGateFlag }

/** The flag key of a city, or null when the place cannot make a valid one. "IN", "pune" -> "romance.city.in-pune". */
export function cityFlagKey(countryCode: string | null | undefined, cityKey: string | null | undefined): string | null {
  if (!countryCode || !cityKey) return null
  const key = `${ROMANCE_CITY_FLAG_PREFIX}${countryCode.toLowerCase()}-${cityKey}`
  return FLAG_KEY_PATTERN.test(key) ? key : null
}

export interface Place {
  countryCode: string | null
  cityKey: string | null
}

/** Pure: whether the mode is open for this person, given every flag and where they are. */
export function romanceOpen(flags: readonly FlagRecord[], userId: string | null | undefined, place: Place | null): boolean {
  const byKey = new Map(flags.map((flag) => [flag.key, flag]))
  if (byKey.get(ROMANCE_KILL_FLAG)?.enabled) return false
  if (evaluateFlag(byKey.get(ROMANCE_LAUNCH_FLAG), userId)) return true
  const key = place ? cityFlagKey(place.countryCode, place.cityKey) : null
  return key ? evaluateFlag(byKey.get(key), userId) : false
}

/** Whether any flag could open the mode for somebody: the cheap test that lets the weekly job, and a request from a person with no place to look up, do nothing at once. */
export function romanceOpenAnywhere(flags: readonly FlagRecord[]): boolean {
  if (flags.some((flag) => flag.key === ROMANCE_KILL_FLAG && flag.enabled)) return false
  return flags.some((flag) => (flag.key === ROMANCE_LAUNCH_FLAG || flag.key.startsWith(ROMANCE_CITY_FLAG_PREFIX)) && (flag.enabled || flag.allowUserIds.length > 0))
}

type Db = Pick<PrismaClient, 'featureFlag' | 'profile'>

async function placeOf(db: Pick<PrismaClient, 'profile'>, userId: string): Promise<Place | null> {
  const profile = await db.profile.findUnique({ where: { userId }, select: { countryCode: true, cityKey: true } })
  return profile ?? null
}

/**
 * Whether the mode is open for this person. A flag store that cannot be read means CLOSED (the opposite of the kill switches: a mode that has not been opened on purpose is not opened by
 * an outage).
 */
export async function romanceOpenFor(db: Db, userId: string, cache?: Cache): Promise<boolean> {
  try {
    const flags = await loadFlags(db, cache)
    if (!romanceOpenAnywhere(flags)) return false
    // The place is only looked up when it can matter.
    const everywhere = romanceOpen(flags, userId, null)
    if (everywhere) return true
    return romanceOpen(flags, userId, await placeOf(db, userId))
  } catch (error) {
    log.warn('could not read the romance launch flags; treating the mode as closed', { error })
    return false
  }
}

/** Of these people, the ones the mode is open for (for a job that does something for many). */
export async function romanceOpenForMany(db: Db & Pick<PrismaClient, 'profile'>, userIds: readonly string[], cache?: Cache): Promise<Set<string>> {
  const open = new Set<string>()
  if (userIds.length === 0) return open
  try {
    const flags = await loadFlags(db, cache)
    if (!romanceOpenAnywhere(flags)) return open
    const needPlace: string[] = []
    for (const id of userIds) {
      if (romanceOpen(flags, id, null)) open.add(id)
      else needPlace.push(id)
    }
    if (needPlace.length > 0) {
      const places = await db.profile.findMany({ where: { userId: { in: needPlace } }, select: { userId: true, countryCode: true, cityKey: true } })
      for (const place of places) if (romanceOpen(flags, place.userId, place)) open.add(place.userId)
    }
  } catch (error) {
    log.warn('could not read the romance launch flags; treating the mode as closed', { error })
    return new Set()
  }
  return open
}

/** Whether a notification kind belongs to the romance mode (it is left out of the lists while the mode is closed). */
export const isRomanceKind = (kind: string): boolean => kind.startsWith('ROMANCE_')
