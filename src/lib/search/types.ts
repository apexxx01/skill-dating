// The search interface (docs/SEARCH.md). The route and the service depend on `SearchProvider` only; PostgreSQL implements it today (postgres.ts), and Meilisearch or
// Typesense can implement it later without a route, a response or a test changing.

export const SEARCH_TYPES = ['users', 'projects', 'crews', 'hackathons', 'posts'] as const
export type SearchType = (typeof SEARCH_TYPES)[number]

/** The order types sort in when two results score the same, and the second part of a cursor. */
export const TYPE_ORDER: Record<SearchType, number> = { users: 0, projects: 1, crews: 2, hackathons: 3, posts: 4 }

export const SEARCH_LIMITS = {
  minQueryLength: 2,
  maxQueryLength: 100,
  maxWords: 8,
  maxWordLength: 40,
  defaultLimit: 10,
  maxLimit: 25,
} as const

/** What the person asked for, tidied (query.ts). */
export interface SearchQuery {
  /** The text as a lower-case, accent-free line of words. */
  text: string
  /** The words of it, for prefix matching. */
  words: string[]
  types: SearchType[]
  /** One more than the page, so the service can tell whether there is a next one. */
  limit: number
  after: SearchCursor | null
}

/** What the caller may see, worked out once from the database (index.ts). A provider applies all of it inside its query. */
export interface SearchScope {
  viewerId: string
  /** People the caller blocked or muted, who blocked them. Never returned, and nothing they made. */
  hiddenUserIds: string[]
  /** People the caller follows: their FOLLOWERS posts are visible. */
  followingIds: string[]
  /** Projects the caller owns or belongs to: private projects and CREW posts of these are visible. */
  projectIds: string[]
  /** Crews the caller is a member of: CREW posts of these are visible. */
  teamIds: string[]
  now: Date
}

export interface UserHit {
  type: 'user'
  id: string
  username: string
  name: string | null
  /** Only when the person made it public. */
  headline: string | null
  image: string | null
}

export interface ProjectHit {
  type: 'project'
  id: string
  slug: string
  name: string
  summary: string | null
  status: string
  isPublic: boolean
}

export interface CrewHit {
  type: 'crew'
  id: string
  slug: string
  name: string
  summary: string | null
  isRecruiting: boolean
  memberCount: number
}

export interface HackathonHit {
  type: 'hackathon'
  id: string
  slug: string
  name: string
  summary: string | null
  status: string
  startsAt: string
  /** False for an external hackathon nobody has verified yet. */
  verified: boolean
}

export interface PostHit {
  type: 'post'
  id: string
  title: string
  /** The start of the body. */
  excerpt: string
  kind: string
  createdAt: string
  author: { id: string; username: string; name: string | null }
}

export type SearchHit = UserHit | ProjectHit | CrewHit | HackathonHit | PostHit

/** The type (the name used in `types=`) a hit belongs to. */
export const HIT_TYPE: Record<SearchHit['type'], SearchType> = { user: 'users', project: 'projects', crew: 'crews', hackathon: 'hackathons', post: 'posts' }

/** A hit with the numbers its place in the list is made of. */
export interface RankedHit {
  hit: SearchHit
  score: number
}

export interface SearchCursor {
  score: number
  type: SearchType
  id: string
}

export interface SearchPage {
  /** Ranked, best first, at most `query.limit`. */
  hits: RankedHit[]
}

export interface SearchProvider {
  readonly kind: 'postgres'
  search(query: SearchQuery, scope: SearchScope): Promise<SearchPage>
}

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, s: cursor.score, t: cursor.type, i: cursor.id }), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: unknown; s?: unknown; t?: unknown; i?: unknown }
    if (value.v !== 1 || typeof value.s !== 'number' || !Number.isFinite(value.s) || value.s < 0 || value.s > 10) return null
    if (typeof value.t !== 'string' || !(SEARCH_TYPES as readonly string[]).includes(value.t)) return null
    if (typeof value.i !== 'string' || value.i.length === 0 || value.i.length > 64) return null
    return { score: value.s, type: value.t as SearchType, id: value.i }
  } catch {
    return null
  }
}
