import { Prisma, type PrismaClient } from '@prisma/client'
import { getCache, type Cache, type ScoredMember } from '@/lib/infra/cache'
import { boardKey, periodsAt, scopesOf, type BoardMembership, type PeriodRef } from '@/lib/leaderboard-boards'
import { log } from '@/lib/log'

// Keeping the Redis leaderboards right. The XPEvent log is the truth; the boards are a fast copy of it, kept
// up to date in three ways, each covering what the one before can miss:
//
//  1. recordBoardXp(): every award moves the user's score on each of their boards, right after the
//     transaction that paid it commits - one pipelined call to the cache;
//  2. refreshUserBoards(): when somebody changes where they are, or opts in or out, their entries are moved
//     (the job leaderboards/refresh-user);
//  3. rebuildBoards(): every night, every board of the current periods is rebuilt from the log and swapped
//     in whole (the job leaderboards/reconcile), which repairs anything a failure or a race in 1 and 2 left
//     behind. XP that arrives between reading the log and the swap can be counted twice or missed until the
//     next run: a few awards of drift at the worst, never more.

type Db = Pick<PrismaClient, '$queryRaw' | 'profile' | 'season'>

/** Set once boards have been built from the log, so a cold cache (a restart, a new Redis) knows to build them. */
export const BOARDS_READY_KEY = 'lb:ready'
const READY_TTL_MS = 400 * 24 * 60 * 60 * 1000

export async function loadMembership(db: Pick<PrismaClient, 'profile'>, userId: string): Promise<BoardMembership> {
  const profile = await db.profile.findUnique({
    where: { userId },
    select: { hideFromLeaderboards: true, countryCode: true, cityKey: true, campusKey: true },
  })
  return {
    hidden: profile?.hideFromLeaderboards ?? false,
    countryCode: profile?.countryCode ?? null,
    cityKey: profile?.cityKey ?? null,
    campusKey: profile?.campusKey ?? null,
  }
}

export async function currentPeriods(db: Pick<PrismaClient, 'season'>, now: Date = new Date()): Promise<PeriodRef[]> {
  const season = await db.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' }, select: { id: true, endsAt: true } })
  return periodsAt(now, season)
}

export interface BoardXp {
  userId: string
  amount: number
  at: Date
  seasonId: string | null
}

/** Adds an award to every board its owner is on, in one round trip. Nothing for somebody who opted out. */
export async function recordBoardXp(db: Db, cache: Cache, earned: BoardXp): Promise<void> {
  if (!(earned.amount > 0)) return
  const [membership, periods] = await Promise.all([loadMembership(db, earned.userId), currentPeriods(db, earned.at)])
  const scopes = scopesOf(membership)
  if (scopes.length === 0) return

  const operations = periods
    // The season board takes the XP that was stamped with its season, not whichever season is running now.
    .filter((period) => period.period !== 'season' || period.seasonId === earned.seasonId)
    .flatMap((period) =>
      scopes.map((scope) => ({
        key: boardKey(period, scope),
        member: earned.userId,
        by: earned.amount,
        ...(period.ttlMs ? { ttlMs: period.ttlMs } : {}),
      }))
    )
  await cache.zincrMany(operations)
}

// --- Reading the log ---------------------------------------------------------------------------------

function periodFilter(period: PeriodRef): Prisma.Sql {
  if (period.seasonId) return Prisma.sql`AND e."seasonId" = ${period.seasonId}`
  if (period.start && period.end) return Prisma.sql`AND e."createdAt" >= ${period.start} AND e."createdAt" < ${period.end}`
  return Prisma.empty
}

interface ScoreRow {
  userId: string
  score: number
  countryCode: string | null
  cityKey: string | null
  campusKey: string | null
}

async function scoresFor(db: Pick<PrismaClient, '$queryRaw'>, period: PeriodRef): Promise<ScoreRow[]> {
  return db.$queryRaw<ScoreRow[]>`
    SELECT e."userId", SUM(e."amount")::int AS "score", p."countryCode", p."cityKey", p."campusKey"
    FROM "XPEvent" e
    JOIN "User" u ON u."id" = e."userId" AND u."deletedAt" IS NULL
    LEFT JOIN "Profile" p ON p."userId" = e."userId"
    WHERE COALESCE(p."hideFromLeaderboards", false) = false ${periodFilter(period)}
    GROUP BY e."userId", p."countryCode", p."cityKey", p."campusKey"
    HAVING SUM(e."amount") > 0
  `
}

export interface RebuildResult {
  periods: number
  boards: number
  members: number
}

/**
 * Rebuilds every board of the current periods from the XPEvent log and swaps each in whole. People who
 * opted out, whose account is gone, or who have no XP in the period are not on the new boards.
 */
export async function rebuildBoards(db: Db, cache: Cache = getCache(), now: Date = new Date()): Promise<RebuildResult> {
  const periods = await currentPeriods(db, now)
  let boards = 0
  let members = 0

  for (const period of periods) {
    const rows = await scoresFor(db, period)
    const byBoard = new Map<string, ScoredMember[]>()
    for (const row of rows) {
      const member: BoardMembership = { hidden: false, countryCode: row.countryCode, cityKey: row.cityKey, campusKey: row.campusKey }
      for (const scope of scopesOf(member)) {
        const key = boardKey(period, scope)
        const entries = byBoard.get(key) ?? []
        entries.push({ member: row.userId, score: row.score })
        byBoard.set(key, entries)
      }
    }
    // The global board is always replaced, even when it is empty, so a board of departed people does not linger.
    const globalKey = boardKey(period, 'g')
    if (!byBoard.has(globalKey)) byBoard.set(globalKey, [])

    for (const [key, entries] of byBoard) {
      await cache.zreplace(key, entries, period.ttlMs ? { ttlMs: period.ttlMs } : {})
      boards += 1
      members += entries.length
    }
  }

  await cache.set(BOARDS_READY_KEY, new Date(now).toISOString(), { ttlMs: READY_TTL_MS })
  log.info('leaderboards rebuilt', { periods: periods.length, boards, members })
  return { periods: periods.length, boards, members }
}

/** A person's XP in each of the current periods, from the log. */
async function ownScores(db: Pick<PrismaClient, '$queryRaw'>, userId: string, periods: PeriodRef[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>()
  for (const period of periods) {
    const [row] = await db.$queryRaw<{ score: number | null }[]>`
      SELECT SUM(e."amount")::int AS "score" FROM "XPEvent" e WHERE e."userId" = ${userId} ${periodFilter(period)}
    `
    scores.set(period.key, row?.score ?? 0)
  }
  return scores
}

export interface RefreshResult {
  added: number
  removed: number
}

/**
 * Puts one person's entries where they now belong, after their place or their privacy changed:
 * removed from the boards they were on and are not any more, and set (not added to) on the ones they are
 * on, from their XP in the log. `previous` is what they were before the change; without it only the
 * boards they should be on now are written.
 */
export async function refreshUserBoards(db: Db, cache: Cache, userId: string, previous: BoardMembership | null, now: Date = new Date()): Promise<RefreshResult> {
  const [current, periods] = await Promise.all([loadMembership(db, userId), currentPeriods(db, now)])
  const wanted = scopesOf(current)
  const wantedKeys = new Set(wanted.map((scope) => scope.key))
  const before = previous ? scopesOf(previous) : []
  const scores = await ownScores(db, userId, periods)

  let added = 0
  let removed = 0
  for (const period of periods) {
    for (const scope of before) {
      if (wantedKeys.has(scope.key)) continue
      if (await cache.zrem(boardKey(period, scope), userId)) removed += 1
    }
    const score = scores.get(period.key) ?? 0
    for (const scope of wanted) {
      const key = boardKey(period, scope)
      if (score > 0) {
        await cache.zadd(key, userId, score)
        if (period.ttlMs) await cache.expire(key, period.ttlMs)
        added += 1
      } else if (await cache.zrem(key, userId)) {
        removed += 1
      }
    }
  }
  return { added, removed }
}

/** What the nightly job runs. */
export async function runReconcileJob(): Promise<RebuildResult> {
  const { prisma } = await import('@/lib/prisma')
  return rebuildBoards(prisma)
}

/** What the per-user job runs. */
export async function runRefreshUserJob(userId: string, previous: BoardMembership | null): Promise<RefreshResult> {
  const { prisma } = await import('@/lib/prisma')
  return refreshUserBoards(prisma, getCache(), userId, previous)
}
