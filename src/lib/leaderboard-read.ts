import { Prisma, type PrismaClient } from '@prisma/client'
import type { LeaderboardEntry, LeaderboardResponse } from '@/types/api'
import { decodeRankCursor, encodeRankCursor } from '@/lib/api/pagination'
import { getCache, type Cache, type ScoredMember } from '@/lib/infra/cache'
import { getJobQueue } from '@/lib/infra/jobs'
import { boardKey, ownScopeIds, scopeRef, type BoardPeriod, type BoardScope, type CachedScope, type PeriodRef } from '@/lib/leaderboard-boards'
import { BOARDS_READY_KEY, currentPeriods, loadMembership, rebuildBoards } from '@/lib/leaderboard-write'
import { levelFor } from '@/lib/levels'
import { log } from '@/lib/log'

// Reading a leaderboard. A board is a ranked list; what the viewer sees is that list minus the people
// they have blocked (or who have blocked them), RE-NUMBERED so ranks are consecutive over what they can see.
// A rank is therefore a property of (board, viewer): the same person can be 5th for one viewer and 6th for another.
//
// Both kinds of board are read through the same small interface (`Ranked`): a sorted set in the cache for the
// big boards, and a plain list for a crew, which is summed from the log when it is asked for.

export interface Ranked {
  /** Number of members. */
  size(): Promise<number>
  /** Zero-based position, best first, or null when not on the board. */
  indexOf(member: string): Promise<number | null>
  score(member: string): Promise<number | null>
  /** `count` members from position `from`, best first. */
  slice(from: number, count: number): Promise<ScoredMember[]>
}

export const redisRanked = (cache: Cache, key: string): Ranked => ({
  size: () => cache.zcard(key),
  indexOf: (member) => cache.zrevrank(key, member),
  score: (member) => cache.zscore(key, member),
  slice: (from, count) => cache.ztop(key, count, from),
})

/** Best first; ties by id, descending: the order Redis keeps, so a crew ranks the way the big boards do. */
export function listRanked(entries: ScoredMember[]): Ranked {
  const sorted = [...entries].sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0))
  return {
    size: async () => sorted.length,
    indexOf: async (member) => {
      const index = sorted.findIndex((entry) => entry.member === member)
      return index === -1 ? null : index
    },
    score: async (member) => sorted.find((entry) => entry.member === member)?.score ?? null,
    slice: async (from, count) => sorted.slice(from, from + count),
  }
}

/** Most blocked people whose positions are looked up per read. More than this and ranks may be off by a few. */
export const MAX_BLOCKED_ADJUSTMENTS = 200

export interface RankedRow {
  member: string
  score: number
  /** The rank the viewer sees: 1 is first, and blocked people do not count. */
  rank: number
}

export interface Window {
  rows: RankedRow[]
  /** Members the viewer can see. */
  visibleTotal: number
  /** Positions (zero-based, absolute) of the blocked people who are on this board, ascending. */
  blockedPositions: number[]
}

export async function blockedPositions(source: Ranked, blocked: readonly string[]): Promise<number[]> {
  const positions = await Promise.all(blocked.slice(0, MAX_BLOCKED_ADJUSTMENTS).map((member) => source.indexOf(member)))
  return positions.filter((position): position is number => position !== null).sort((a, b) => a - b)
}

/** The absolute position of the `visible`-th (zero-based) member the viewer can see. */
export function absolutePosition(visible: number, blockedAt: readonly number[]): number {
  let position = visible
  for (const blockedPosition of blockedAt) {
    if (blockedPosition <= position) position += 1
    else break
  }
  return position
}

/** The rank (1 is first) a member at absolute position `position` has for a viewer with these people hidden. */
export function visibleRank(position: number, blockedAt: readonly number[]): number {
  return position - blockedAt.filter((blockedPosition) => blockedPosition < position).length + 1
}

/**
 * `limit` members the viewer can see, starting at their `start`-th (zero-based). Asks for enough rows to
 * step over the blocked ones that fall inside the window, and numbers what is left consecutively.
 */
export async function readWindow(source: Ranked, blocked: readonly string[], start: number, limit: number): Promise<Window> {
  const hiddenAt = await blockedPositions(source, blocked)
  const hidden = new Set(blocked)
  const [size, raw] = await Promise.all([source.size(), source.slice(absolutePosition(start, hiddenAt), limit + hiddenAt.length)])
  const rows = raw
    .filter((row) => !hidden.has(row.member))
    .slice(0, limit)
    .map((row, index) => ({ member: row.member, score: row.score, rank: start + index + 1 }))
  return { rows, visibleTotal: Math.max(size - hiddenAt.length, 0), blockedPositions: hiddenAt }
}

/** Where a member stands for the viewer: their rank and score, or null when they are not on the board. */
export async function standing(source: Ranked, member: string, hiddenAt: readonly number[]): Promise<{ rank: number; score: number } | null> {
  const position = await source.indexOf(member)
  if (position === null) return null
  return { rank: visibleRank(position, hiddenAt), score: (await source.score(member)) ?? 0 }
}

/**
 * Where a page starts (zero-based visible position). A rank cursor names the last row of the previous
 * page: if that person is still on the board the page starts right after where they are NOW, otherwise
 * after the rank they had.
 */
export async function startOf(source: Ranked, hiddenAt: readonly number[], position: { rank: number; member?: string } | null, page: number, limit: number): Promise<number> {
  if (!position) return (page - 1) * limit
  if (position.member) {
    const at = await source.indexOf(position.member)
    if (at !== null) return visibleRank(at, hiddenAt)
  }
  return position.rank
}

// --- Cold boards -------------------------------------------------------------------------------

let rebuilding: Promise<unknown> | undefined

/**
 * A board that was never built (a restart of the in-process cache, a new Redis) is built from the log
 * first. With the in-process cache that happens right here; with Redis it is a job, because a rebuild is
 * a table-wide sum and does not belong in a request, and the boards fill in as the job finishes and as
 * people earn XP.
 */
export async function ensureBoardsBuilt(db: Pick<PrismaClient, '$queryRaw' | 'profile' | 'season'>, cache: Cache): Promise<void> {
  if (await cache.get(BOARDS_READY_KEY)) return
  if (cache.kind === 'memory') {
    rebuilding ??= rebuildBoards(db, cache).finally(() => {
      rebuilding = undefined
    })
    await rebuilding
    return
  }
  try {
    await getJobQueue().enqueue('leaderboards/reconcile', {}, { id: `leaderboards-cold-start-${Math.floor(Date.now() / 3_600_000)}` })
  } catch (error) {
    log.warn('could not queue the first leaderboard build', { error })
  }
}

// --- The crew board, from the log -----------------------------------------------------------------

export async function crewEntries(db: Pick<PrismaClient, '$queryRaw'>, teamId: string, period: PeriodRef): Promise<ScoredMember[]> {
  const window = period.seasonId
    ? Prisma.sql`AND e."seasonId" = ${period.seasonId}`
    : period.start && period.end
      ? Prisma.sql`AND e."createdAt" >= ${period.start} AND e."createdAt" < ${period.end}`
      : Prisma.empty
  const rows = await db.$queryRaw<{ userId: string; score: number }[]>`
    SELECT m."userId", SUM(e."amount")::int AS "score"
    FROM "TeamMember" m
    JOIN "User" u ON u."id" = m."userId" AND u."deletedAt" IS NULL
    LEFT JOIN "Profile" p ON p."userId" = m."userId"
    JOIN "XPEvent" e ON e."userId" = m."userId" ${window}
    WHERE m."teamId" = ${teamId} AND COALESCE(p."hideFromLeaderboards", false) = false
    GROUP BY m."userId"
    HAVING SUM(e."amount") > 0
  `
  return rows.map((row) => ({ member: row.userId, score: row.score }))
}

// --- The whole read ----------------------------------------------------------------------------------

export interface LeaderboardQuery {
  viewerId: string
  period: BoardPeriod
  scope: BoardScope
  /** Canonical scope id (see parseScopeId), or null for the viewer's own / global. */
  scopeId: string | null
  /** Cursor from the previous page; wins over `page`. */
  cursor: string | undefined
  page: number
  limit: number
  /** People the viewer cannot see. */
  blocked: readonly string[]
  now?: Date
}

export type LeaderboardOutcome =
  | { kind: 'ok'; data: LeaderboardResponse }
  | { kind: 'invalid-cursor' }
  | { kind: 'scope-missing'; scope: BoardScope }
  | { kind: 'crew-not-found' }

type Db = Pick<PrismaClient, '$queryRaw' | 'profile' | 'season' | 'user' | 'team'>

export async function readLeaderboard(db: Db, query: LeaderboardQuery, cache: Cache = getCache()): Promise<LeaderboardOutcome> {
  return readOnce(db, query, cache, 0)
}

/** How many times one read may clean ghosts off a board and start again. */
const MAX_CLEANUPS = 3

async function readOnce(db: Db, query: LeaderboardQuery, cache: Cache, cleanups: number): Promise<LeaderboardOutcome> {
  const now = query.now ?? new Date()
  const position = query.cursor === undefined ? null : decodeRankCursor(query.cursor)
  if (query.cursor !== undefined && !position) return { kind: 'invalid-cursor' }

  await ensureBoardsBuilt(db, cache)
  const [periods, mine, season] = await Promise.all([
    currentPeriods(db, now),
    loadMembership(db, query.viewerId),
    db.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' }, select: { id: true, number: true, name: true, startsAt: true, endsAt: true } }),
  ])
  const period = periods.find((candidate) => candidate.period === query.period)
  const myScopes = ownScopeIds(mine)

  // Resolve the scope to a board.
  let source: Ranked
  let cachedKey: string | null = null
  let scopeId: string | null = query.scopeId
  if (query.scope === 'crew') {
    if (!scopeId) return { kind: 'scope-missing', scope: 'crew' }
    if (!(await db.team.findUnique({ where: { id: scopeId }, select: { id: true } }))) return { kind: 'crew-not-found' }
    source = period ? listRanked(await crewEntries(db, scopeId, period)) : listRanked([])
  } else {
    if (query.scope !== 'global') scopeId ??= myScopes[query.scope]
    if (query.scope !== 'global' && !scopeId) return { kind: 'scope-missing', scope: query.scope }
    // No board between seasons: an empty one, so the client has one thing to render.
    if (period) cachedKey = boardKey(period, scopeRef(query.scope as CachedScope, query.scope === 'global' ? null : scopeId))
    source = cachedKey ? redisRanked(cache, cachedKey) : listRanked([])
  }

  const hiddenAt = await blockedPositions(source, query.blocked)
  const start = await startOf(source, hiddenAt, position, query.page, query.limit)
  const window = await readWindow(source, query.blocked, start, query.limit + 1)
  const hasMore = window.rows.length > query.limit
  const pageRows = window.rows.slice(0, query.limit)

  const me = mine.hidden ? null : await standing(source, query.viewerId, window.blockedPositions)
  const aroundStart = me ? Math.max(me.rank - 1 - 2, 0) : 0
  // Two above and two below: fewer at the edges, where there is nobody further up or down to show.
  const aroundWindow = me ? await readWindow(source, query.blocked, aroundStart, me.rank - 1 - aroundStart + 3) : null

  // Hydrate the people on the page and around the viewer in one query.
  const ids = [...new Set([...pageRows.map((row) => row.member), ...(aroundWindow?.rows ?? []).map((row) => row.member)])]
  const users = await db.user.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true, xp: true },
  })
  const byId = new Map(users.map((user) => [user.id, user]))

  // Somebody on the board whose account is gone (deleted, or a Clerk deletion not yet swept) would leave a hole
  // in the ranks. Take them off the board and read again; the nightly rebuild leaves them out in the first place.
  const ghosts = ids.filter((id) => !byId.has(id))
  if (ghosts.length > 0 && cachedKey && cleanups < MAX_CLEANUPS) {
    await Promise.all(ghosts.map((id) => cache.zrem(cachedKey!, id)))
    return readOnce(db, query, cache, cleanups + 1)
  }
  const entry = (row: RankedRow): LeaderboardEntry | null => {
    const user = byId.get(row.member)
    if (!user) return null
    const { level, tier } = levelFor(user.xp)
    return {
      rank: row.rank,
      score: row.score,
      xp: row.score,
      level,
      tier,
      user: { id: user.id, name: user.name, username: user.username, image: user.image, headline: user.headline, builderRole: user.builderRole },
    }
  }

  const entries = pageRows.map(entry).filter((item): item is LeaderboardEntry => item !== null)
  const last = pageRows[pageRows.length - 1]
  const data: LeaderboardResponse = {
    period: query.period,
    scope: { type: query.scope, id: query.scope === 'global' ? null : scopeId },
    season: query.period === 'season' && season ? { id: season.id, number: season.number, name: season.name, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString() } : null,
    entries,
    me: { rank: me?.rank ?? null, score: me?.score ?? 0, xp: me?.score ?? 0, hidden: mine.hidden },
    around: (aroundWindow?.rows ?? []).map(entry).filter((item): item is LeaderboardEntry => item !== null),
    myScopes,
    nextCursor: hasMore && last ? encodeRankCursor({ rank: last.rank, member: last.member }) : null,
    // A page-numbered request keeps the counts it always had; a cursor request runs no count.
    ...(query.cursor === undefined
      ? { pagination: { page: query.page, limit: query.limit, total: window.visibleTotal, totalPages: Math.ceil(window.visibleTotal / query.limit) } }
      : {}),
  }
  return { kind: 'ok', data }
}
