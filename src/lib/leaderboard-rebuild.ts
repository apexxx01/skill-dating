import { Prisma, type PrismaClient } from '@prisma/client'
import { getCache, type Cache, type ScoredMember, type ZStage } from '@/lib/infra/cache'
import { boardKey, scopesOf, type BoardMembership, type PeriodRef } from '@/lib/leaderboard-boards'
import { BOARDS_READY_KEY, currentPeriods, periodFilter } from '@/lib/leaderboard-write'
import { log } from '@/lib/log'
import { utcTimestamp } from '@/lib/sql'

// Rebuilding the leaderboards from the XPEvent log (the job leaderboards/reconcile, nightly) without drift.
//
// The log is the truth and the boards are a copy that every award also moves, right after it commits. A rebuild
// that reads the log, takes a while, and swaps the result in would lose whatever was earned in between. So for
// each period, boards are built in four steps, and XP that arrives at any point is counted exactly once:
//
//  1. Pick a cutoff T a minute in the past. The lag is the room for awards still being committed: an event is
//     created inside its transaction, so one stamped before T is visible by the time we look, unless its
//     transaction took longer than a minute.
//  2. Aggregate the log up to T in the database, a batch of people at a time (keyset on the user id), and write
//     each batch into a STAGED copy of every board it belongs on. The real boards are not touched, and no more
//     than a batch is ever held in memory.
//  3. Replay what came after T. Anyone with an event stamped after T has their whole score for the period
//     re-read from the log and SET on the staged boards. Setting an absolute score (rather than adding what
//     happened since) is what makes this exactly once: it cannot count an event the aggregate already counted,
//     and doing it again changes nothing. It repeats, each pass looking at what arrived since the last, until a
//     pass finds nothing new.
//  4. Swap each staged board in for the real one with one rename.
//  5. Settle. Anyone with an event stamped since the last replay pass began has their whole score re-read and SET
//     on the live boards. An award that committed between that pass and the rename moved the old board, which the
//     rename replaced; this puts it back, and it is just as right when the award landed on the new board.
//
// What is still possible: an award that commits after the settle pass has read the log, or in the milliseconds
// between that read and the write of its SET, which the next run repairs. Moves (a new country, opting out) in
// the same window have the same fate. Nothing else drifts.

type Db = Pick<PrismaClient, '$queryRaw' | 'profile' | 'season'>

/** How long before "now" the cutoff sits. See the notes above. */
export const SNAPSHOT_LAG_MS = 60_000
/** People per batch of the aggregate, and of the replay. */
export const REBUILD_BATCH = 5000
const REPLAY_BATCH = 500
/** Replay passes before giving up on the log going quiet and swapping anyway. */
const MAX_REPLAY_PASSES = 6

export interface ScoreRow {
  userId: string
  score: number
  countryCode: string | null
  cityKey: string | null
  campusKey: string | null
}

/** Where a person stands in the log right now. */
export interface Standing extends BoardMembership {
  userId: string
  /** XP in the period. */
  score: number
  /** False for an account that is gone. */
  alive: boolean
}

/** The reads a rebuild needs from the log. Behind an interface so the algorithm can be tested on its own. */
export interface LogReader {
  /** People with XP in the period stamped at or before `cutoff` (positive totals only, opted out and deleted left out), ordered by id, after `after`. */
  scoresUpTo(period: PeriodRef, cutoff: Date, after: string, size: number): Promise<ScoreRow[]>
  /** Ids (ascending, after `after`) of people with an event in the period stamped after `since`. */
  touchedSince(period: PeriodRef, since: Date, after: string, size: number): Promise<string[]>
  /** The present standing of these people, from the log and their profiles. */
  standings(period: PeriodRef, userIds: string[]): Promise<Standing[]>
}

export function prismaLogReader(db: Pick<PrismaClient, '$queryRaw'>): LogReader {
  return {
    scoresUpTo: (period, cutoff, after, size) =>
      db.$queryRaw<ScoreRow[]>`
        SELECT e."userId", SUM(e."amount")::int AS "score", p."countryCode", p."cityKey", p."campusKey"
        FROM "XPEvent" e
        JOIN "User" u ON u."id" = e."userId" AND u."deletedAt" IS NULL
        LEFT JOIN "Profile" p ON p."userId" = e."userId"
        WHERE COALESCE(p."hideFromLeaderboards", false) = false
          AND e."userId" > ${after} AND e."createdAt" <= ${utcTimestamp(cutoff)} ${periodFilter(period)}
        GROUP BY e."userId", p."countryCode", p."cityKey", p."campusKey"
        HAVING SUM(e."amount") > 0
        ORDER BY e."userId"
        LIMIT ${size}
      `,
    touchedSince: async (period, since, after, size) => {
      const rows = await db.$queryRaw<{ userId: string }[]>`
        SELECT DISTINCT e."userId"
        FROM "XPEvent" e
        WHERE e."userId" > ${after} AND e."createdAt" > ${utcTimestamp(since)} ${periodFilter(period)}
        ORDER BY e."userId"
        LIMIT ${size}
      `
      return rows.map((row) => row.userId)
    },
    standings: async (period, userIds) => {
      if (userIds.length === 0) return []
      return db.$queryRaw<Standing[]>`
        SELECT u."id" AS "userId", (u."deletedAt" IS NULL) AS "alive",
          COALESCE(p."hideFromLeaderboards", false) AS "hidden", p."countryCode", p."cityKey", p."campusKey",
          COALESCE((SELECT SUM(e."amount")::int FROM "XPEvent" e WHERE e."userId" = u."id" ${periodFilter(period)}), 0) AS "score"
        FROM "User" u
        LEFT JOIN "Profile" p ON p."userId" = u."id"
        WHERE u."id" IN (${Prisma.join(userIds)})
      `
    },
  }
}

export interface RebuildResult {
  periods: number
  boards: number
  members: number
  /** People whose score was re-read because they earned after the cutoff. */
  replayed: number
  /** People whose live score was corrected by the final pass after the swap. */
  settled: number
}

export interface RebuildOptions {
  reader?: LogReader
  /** The clock the cutoff is taken from. */
  clock?: () => number
  lagMs?: number
  batchSize?: number
  /** Called between the steps of a period, `replaying` before each replay pass reads the log (tests use it to make XP land at a chosen moment). */
  onStep?: (step: { name: 'cutoff' | 'aggregated' | 'replaying' | 'swapping' | 'settling'; period: PeriodRef; pass?: number }) => void | Promise<void>
}

/** A fingerprint of what was staged for somebody, to tell whether a replay pass found anything new. */
function fingerprint(standing: Standing): string {
  return [standing.alive, standing.hidden, standing.score, standing.countryCode, standing.cityKey, standing.campusKey].join('|')
}

/**
 * Rebuilds every board of the current periods from the XPEvent log and swaps each in whole. People who
 * opted out, whose account is gone, or who have no XP in the period are not on the new boards.
 */
export async function rebuildBoards(db: Db, cache: Cache = getCache(), now: Date = new Date(), options: RebuildOptions = {}): Promise<RebuildResult> {
  const reader = options.reader ?? prismaLogReader(db)
  const clock = options.clock ?? Date.now
  const lagMs = options.lagMs ?? SNAPSHOT_LAG_MS
  const batchSize = options.batchSize ?? REBUILD_BATCH
  const periods = await currentPeriods(db, now)
  const result: RebuildResult = { periods: periods.length, boards: 0, members: 0, replayed: 0, settled: 0 }

  for (const period of periods) {
    const stages = new Map<string, ZStage>()
    const stageFor = (key: string) => {
      let stage = stages.get(key)
      if (!stage) {
        stage = cache.zstage(key)
        stages.set(key, stage)
      }
      return stage
    }
    const step = async (name: 'cutoff' | 'aggregated' | 'replaying' | 'swapping' | 'settling', pass?: number) => options.onStep?.({ name, period, pass })

    try {
      // 1 and 2: everything up to the cutoff, a batch of people at a time.
      const cutoff = new Date(clock() - lagMs)
      await step('cutoff')
      let after = ''
      for (;;) {
        const rows = await reader.scoresUpTo(period, cutoff, after, batchSize)
        const byBoard = new Map<string, ScoredMember[]>()
        for (const row of rows) {
          for (const scope of scopesOf({ hidden: false, countryCode: row.countryCode, cityKey: row.cityKey, campusKey: row.campusKey })) {
            const key = boardKey(period, scope)
            const entries = byBoard.get(key) ?? []
            entries.push({ member: row.userId, score: row.score })
            byBoard.set(key, entries)
          }
        }
        for (const [key, entries] of byBoard) await stageFor(key).set(entries)
        result.members += rows.length
        if (rows.length < batchSize) break
        after = rows[rows.length - 1].userId
      }
      // The global board is always replaced, even when it is empty, so a board of departed people does not linger.
      stageFor(boardKey(period, 'g'))
      await step('aggregated')

      // 3: replay what came after the cutoff, until a pass finds nothing new.
      const staged = new Map<string, string>()
      let since = cutoff
      // Where the last replay pass started looking: the final pass after the swap starts there.
      let settleFrom = cutoff
      for (let pass = 1; ; pass++) {
        // Called before the pass reads the log, so whatever lands at this step is read by this pass.
        await step('replaying', pass)
        const passFrom = new Date(clock() - lagMs)
        settleFrom = passFrom
        let changed = 0
        let touchedAfter = ''
        for (;;) {
          const ids = await reader.touchedSince(period, since, touchedAfter, REPLAY_BATCH)
          if (ids.length === 0) break
          touchedAfter = ids[ids.length - 1]
          for (const standing of await reader.standings(period, ids)) {
            if (staged.get(standing.userId) === fingerprint(standing)) continue
            staged.set(standing.userId, fingerprint(standing))
            changed += 1
            await replay(period, standing, stages, stageFor)
          }
          if (ids.length < REPLAY_BATCH) break
        }
        result.replayed += changed
        if (changed === 0) break
        if (pass >= MAX_REPLAY_PASSES) {
          log.warn('leaderboard rebuild did not settle; swapping anyway', { period: period.key, passes: pass })
          break
        }
        since = passFrom
      }

      // 4: swap.
      await step('swapping')
      for (const stage of stages.values()) {
        await stage.commit(period.ttlMs ? { ttlMs: period.ttlMs } : {})
        result.boards += 1
      }

      // 5: settle. An award that committed between the last replay pass and the rename moved a board the rename
      // then replaced, so it would be missing until the next run. Anyone with an event stamped since the last pass
      // began has their whole score re-read and SET on the live boards: absolute, so it is right whether their
      // increment landed on the old board (lost) or the new one (kept), and doing it twice changes nothing.
      await step('settling')
      result.settled += await settle(reader, cache, period, settleFrom, staged)
    } catch (error) {
      await Promise.allSettled([...stages.values()].map((stage) => stage.discard()))
      throw error
    }
  }

  await cache.set(BOARDS_READY_KEY, new Date(now).toISOString(), { ttlMs: READY_TTL_MS })
  log.info('leaderboards rebuilt', { ...result })
  return result
}

const READY_TTL_MS = 400 * 24 * 60 * 60 * 1000

/**
 * The final pass, on the live boards after the swap: everybody with an event in the period stamped after `since`
 * has their standing re-read and set. People whose standing is what was staged are skipped (the swap already put
 * it there). Returns how many were corrected.
 */
async function settle(reader: LogReader, cache: Cache, period: PeriodRef, since: Date, staged: Map<string, string>): Promise<number> {
  let corrected = 0
  let after = ''
  for (;;) {
    const ids = await reader.touchedSince(period, since, after, REPLAY_BATCH)
    if (ids.length === 0) break
    after = ids[ids.length - 1]
    for (const standing of await reader.standings(period, ids)) {
      if (staged.get(standing.userId) === fingerprint(standing)) continue
      corrected += 1
      const scopes = scopesOf({ hidden: false, countryCode: standing.countryCode, cityKey: standing.cityKey, campusKey: standing.campusKey })
      const on = standing.alive && !standing.hidden && standing.score > 0
      for (const scope of scopes) {
        const key = boardKey(period, scope)
        if (on) {
          await cache.zadd(key, standing.userId, standing.score)
          if (period.ttlMs) await cache.expire(key, period.ttlMs)
        } else {
          await cache.zrem(key, standing.userId)
        }
      }
    }
    if (ids.length < REPLAY_BATCH) break
  }
  return corrected
}

/** Sets one person's whole score on the staged boards they belong on, and takes them off the ones they no longer do. */
async function replay(period: PeriodRef, standing: Standing, stages: Map<string, ZStage>, stageFor: (key: string) => ZStage) {
  const place = { countryCode: standing.countryCode, cityKey: standing.cityKey, campusKey: standing.campusKey }
  const on = standing.alive && !standing.hidden && standing.score > 0
  if (on) {
    for (const scope of scopesOf({ hidden: false, ...place })) await stageFor(boardKey(period, scope)).set([{ member: standing.userId, score: standing.score }])
    return
  }
  for (const scope of scopesOf({ hidden: false, ...place })) await stages.get(boardKey(period, scope))?.remove([standing.userId])
}
