import { Prisma, type PrismaClient } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'
import { boardKey, periodsAt, scopesOf, type BoardMembership, type PeriodRef } from '@/lib/leaderboard-boards'
import { log } from '@/lib/log'
import { utcTimestamp } from '@/lib/sql'

// Keeping the Redis leaderboards right. The XPEvent log is the truth; the boards are a fast copy of it, kept
// up to date in three ways, each covering what the one before can miss:
//
//  1. recordBoardXp(): every award moves the user's score on each of their boards, right after the
//     transaction that paid it commits - one pipelined call to the cache;
//  2. refreshUserBoards(): when somebody changes where they are, or opts in or out, their entries are moved
//     (the job leaderboards/refresh-user);
//  3. rebuildBoards() (leaderboard-rebuild.ts): every night, every board of the current periods is rebuilt
//     from the log, corrected for what was earned while it was being built, and swapped in whole (the job
//     leaderboards/reconcile). That repairs anything a failure or a race in 1 and 2 left behind.

type Db = Pick<PrismaClient, '$queryRaw' | 'profile' | 'season'>

/** Set once boards have been built from the log, so a cold cache (a restart, a new Redis) knows to build them. */
export const BOARDS_READY_KEY = 'lb:ready'

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

export function periodFilter(period: PeriodRef): Prisma.Sql {
  if (period.seasonId) return Prisma.sql`AND e."seasonId" = ${period.seasonId}`
  if (period.start && period.end) return Prisma.sql`AND e."createdAt" >= ${utcTimestamp(period.start)} AND e."createdAt" < ${utcTimestamp(period.end)}`
  return Prisma.empty
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
export async function runReconcileJob() {
  const [{ prisma }, { rebuildBoards }] = await Promise.all([import('@/lib/prisma'), import('@/lib/leaderboard-rebuild')])
  return rebuildBoards(prisma)
}

/** What the per-user job runs. */
export async function runRefreshUserJob(userId: string, previous: BoardMembership | null): Promise<RefreshResult> {
  const { prisma } = await import('@/lib/prisma')
  return refreshUserBoards(prisma, getCache(), userId, previous)
}
