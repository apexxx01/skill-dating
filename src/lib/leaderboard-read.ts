import { Prisma, type PrismaClient } from '@prisma/client'
import type { LeaderboardEntry, LeaderboardResponse } from '@/types/api'
import { decodeRankCursor, encodeRankCursor } from '@/lib/api/pagination'
import { getCache, type Cache, type ScoredMember } from '@/lib/infra/cache'
import { getJobQueue } from '@/lib/infra/jobs'
import { boardKey, ownScopeIds, scopeRef, type BoardPeriod, type BoardScope, type CachedScope, type PeriodRef } from '@/lib/leaderboard-boards'
import { rebuildBoards } from '@/lib/leaderboard-rebuild'
import { BOARDS_READY_KEY, currentPeriods, loadMembership } from '@/lib/leaderboard-write'
import { levelFor } from '@/lib/levels'
import { log } from '@/lib/log'
import { utcTimestamp } from '@/lib/sql'

// Reading a leaderboard. A board is a ranked list, and a rank is a property of the board alone: the same
// person has the same rank for every viewer, and the same rank on their player card. What the viewer sees is
// that list minus the people they have blocked (or who have blocked them), who are simply left out, so the ranks
// on a viewer's page can have gaps (4th, then 6th) and a page can hold fewer than `limit` people.
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

export interface RankedRow {
  member: string
  score: number
  /** The member's rank on the board: 1 is first. The same for every viewer. */
  rank: number
}

/**
 * The members at ranks `from + 1` to `from + count`, minus the hidden ones. Hidden people keep their place:
 * the rows after them are not renumbered, and the window is not extended to make up the count.
 */
export async function readWindow(source: Ranked, hidden: ReadonlySet<string>, from: number, count: number): Promise<{ rows: RankedRow[]; scanned: ScoredMember[] }> {
  const scanned = await source.slice(from, count)
  const rows = scanned.map((row, index) => ({ member: row.member, score: row.score, rank: from + index + 1 })).filter((row) => !hidden.has(row.member))
  return { rows, scanned }
}

/** Where a member stands: their rank and score, or null when they are not on the board. */
export async function standing(source: Ranked, member: string): Promise<{ rank: number; score: number } | null> {
  const position = await source.indexOf(member)
  if (position === null) return null
  return { rank: position + 1, score: (await source.score(member)) ?? 0 }
}

/**
 * Where a page starts (zero-based position on the board). A rank cursor names the last row the previous
 * page covered: if that person is still on the board the page starts right after where they are NOW,
 * otherwise after the rank they had.
 */
export async function startOf(source: Ranked, position: { rank: number; member?: string } | null, page: number, limit: number): Promise<number> {
  if (!position) return (page - 1) * limit
  if (position.member) {
    const at = await source.indexOf(position.member)
    if (at !== null) return at + 1
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
      ? Prisma.sql`AND e."createdAt" >= ${utcTimestamp(period.start)} AND e."createdAt" < ${utcTimestamp(period.end)}`
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

  const hidden = new Set(query.blocked)
  const start = await startOf(source, position, query.page, query.limit)
  const [size, page] = await Promise.all([source.size(), readWindow(source, hidden, start, query.limit)])
  const pageRows = page.rows
  const lastScanned = page.scanned[page.scanned.length - 1]
  const hasMore = start + page.scanned.length < size

  const me = mine.hidden ? null : await standing(source, query.viewerId)
  // Two above and two below: fewer at the edges, where there is nobody further up or down to show.
  const aroundStart = me ? Math.max(me.rank - 1 - 2, 0) : 0
  const aroundWindow = me ? await readWindow(source, hidden, aroundStart, me.rank - 1 - aroundStart + 3) : null

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
  const data: LeaderboardResponse = {
    period: query.period,
    scope: { type: query.scope, id: query.scope === 'global' ? null : scopeId },
    season: query.period === 'season' && season ? { id: season.id, number: season.number, name: season.name, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString() } : null,
    entries,
    me: { rank: me?.rank ?? null, score: me?.score ?? 0, xp: me?.score ?? 0, hidden: mine.hidden },
    around: (aroundWindow?.rows ?? []).map(entry).filter((item): item is LeaderboardEntry => item !== null),
    myScopes,
    // The cursor stands for the last place the page covered, which can be a blocked person's: then it names only the rank.
    nextCursor: hasMore && lastScanned ? encodeRankCursor({ rank: start + page.scanned.length, ...(hidden.has(lastScanned.member) ? {} : { member: lastScanned.member }) }) : null,
    // A page-numbered request keeps the counts it always had; a cursor request runs no count.
    ...(query.cursor === undefined
      ? { pagination: { page: query.page, limit: query.limit, total: size, totalPages: Math.ceil(size / query.limit) } }
      : {}),
  }
  return { kind: 'ok', data }
}
