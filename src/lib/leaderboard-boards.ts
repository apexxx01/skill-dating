import { COUNTRY_CODES, normalizeCountryCode, placeKey } from '@/lib/places'
import { localWeekEnd, localWeekKey, localWeekStart } from '@/lib/time'

// The vocabulary of the leaderboards: which boards exist and what each is called in the cache. Pure.
//
// A board is one period crossed with one scope. Each is a Redis sorted set (members: user ids, scores:
// XP earned in the period) named
//
//   lb:<period>:<scope>      e.g.  lb:w:2026-W42:g      weekly, global
//                                   lb:a:c:IN            all-time, India
//                                   lb:s:season-1:y:IN:bengaluru   Season 1, Bengaluru
//
// Weeks and months are UTC, so everyone's weekly board ends at the same instant (unlike quests and
// streaks, which follow the person's own days). Crew boards are not here: a crew is a handful of
// people, so its board is summed from the log when it is read (leaderboard-read.ts).

export const BOARD_PERIODS = ['weekly', 'monthly', 'season', 'all-time'] as const
export type BoardPeriod = (typeof BOARD_PERIODS)[number]

export const BOARD_SCOPES = ['global', 'country', 'city', 'campus', 'crew'] as const
export type BoardScope = (typeof BOARD_SCOPES)[number]

/** The scopes kept in Redis: everything but crews. */
export type CachedScope = Exclude<BoardScope, 'crew'>

const DAY_MS = 24 * 60 * 60 * 1000

export interface SeasonWindow {
  id: string
  endsAt: Date
}

export interface PeriodRef {
  period: BoardPeriod
  /** The cache name of the period: "w:2026-W42", "m:2026-10", "s:<season id>", "a". */
  key: string
  /** The XP of the period is the XP logged in [start, end); null for the ends that are open. */
  start: Date | null
  end: Date | null
  /** Set for the season board: the XP of the period is the XP stamped with this season. */
  seasonId?: string
  /** How long a board of this period lives after its last write, so finished weeks and months clean themselves up. Null: forever. */
  ttlMs: number | null
}

/** The period of each kind that contains `now`. The season is absent between seasons. */
export function periodsAt(now: Date, season: SeasonWindow | null): PeriodRef[] {
  const weekStart = localWeekStart(now, 'UTC')
  const weekEnd = localWeekEnd(now, 'UTC')
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  const periods: PeriodRef[] = [
    { period: 'weekly', key: `w:${localWeekKey(now, 'UTC')}`, start: weekStart, end: weekEnd, ttlMs: weekEnd.getTime() - now.getTime() + 21 * DAY_MS },
    { period: 'monthly', key: `m:${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`, start: monthStart, end: monthEnd, ttlMs: monthEnd.getTime() - now.getTime() + 60 * DAY_MS },
  ]
  if (season) {
    periods.push({ period: 'season', key: `s:${season.id}`, start: null, end: null, seasonId: season.id, ttlMs: Math.max(season.endsAt.getTime() - now.getTime(), 0) + 120 * DAY_MS })
  }
  periods.push({ period: 'all-time', key: 'a', start: null, end: null, ttlMs: null })
  return periods
}

export interface BoardMembership {
  /** Opted out of leaderboards: on no board at all. */
  hidden: boolean
  countryCode: string | null
  cityKey: string | null
  campusKey: string | null
}

export interface ScopeRef {
  scope: CachedScope
  /** The id a client names it by (`scopeId`): "IN", "IN:bengaluru", "iisc-bangalore"; null for global. */
  id: string | null
  /** The cache name of the scope: "g", "c:IN", "y:IN:bengaluru", "u:iisc-bangalore". */
  key: string
}

const GLOBAL: ScopeRef = { scope: 'global', id: null, key: 'g' }

export function scopeRef(scope: CachedScope, id: string | null): ScopeRef {
  switch (scope) {
    case 'global':
      return GLOBAL
    case 'country':
      return { scope, id, key: `c:${id}` }
    case 'city':
      return { scope, id, key: `y:${id}` }
    case 'campus':
      return { scope, id, key: `u:${id}` }
  }
}

/** The boards a person is on: global, plus their country, their city (within it) and their campus when they have set them. */
export function scopesOf(member: BoardMembership): ScopeRef[] {
  if (member.hidden) return []
  const scopes = [GLOBAL]
  if (member.countryCode) {
    scopes.push(scopeRef('country', member.countryCode))
    if (member.cityKey) scopes.push(scopeRef('city', `${member.countryCode}:${member.cityKey}`))
  }
  if (member.campusKey) scopes.push(scopeRef('campus', member.campusKey))
  return scopes
}

/** The ids a client may use for `scope`, for the person's own place: what the scope picker offers. */
export function ownScopeIds(member: Pick<BoardMembership, 'countryCode' | 'cityKey' | 'campusKey'>): { country: string | null; city: string | null; campus: string | null } {
  return {
    country: member.countryCode,
    city: member.countryCode && member.cityKey ? `${member.countryCode}:${member.cityKey}` : null,
    campus: member.campusKey,
  }
}

export const boardKey = (period: PeriodRef | string, scope: ScopeRef | string) =>
  `lb:${typeof period === 'string' ? period : period.key}:${typeof scope === 'string' ? scope : scope.key}`

/**
 * A `scopeId` from a request, in its canonical form, or null when it is not a valid id for the scope.
 * Case and padding are forgiven ("in", " IN "), the way profile settings forgive them.
 */
export function parseScopeId(scope: CachedScope, raw: string): string | null {
  const text = raw.trim()
  switch (scope) {
    case 'global':
      return null
    case 'country': {
      return normalizeCountryCode(text)
    }
    case 'city': {
      const [country, ...rest] = text.split(':')
      const code = normalizeCountryCode(country)
      const key = rest.length === 1 ? placeKey(rest[0]) : null
      return code && key && COUNTRY_CODES.has(code) ? `${code}:${key}` : null
    }
    case 'campus':
      return placeKey(text)
  }
}
