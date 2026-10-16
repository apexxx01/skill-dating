import { Prisma, type PrismaClient } from '@prisma/client'
import { advisoryLock } from '@/lib/progress'
import { grantSeasonCosmetics, type SeasonCosmeticGrant } from '@/lib/cosmetics'
import { log } from '@/lib/log'

// Seasons: fixed stretches of time with their own leaderboard. Exactly one is active at a time.
// grant() stamps every XPEvent with the active season, so a season's standings are always the sum of
// the XP stamped with it. The rollover job (src/lib/infra/jobs.ts, hourly) closes the season whose
// time is up: it writes the final standings once, deactivates it and opens the next one in the same
// transaction. A placing pays COSMETICS ONLY, never XP (see grantSeasonRewards): a title for the top 100, a
// frame for the top 1% and another for the top 10%, and a badge for everyone who earned XP in the season.

export const SEASON_LENGTH_DAYS = 56 // eight weeks
const DAY_MS = 24 * 60 * 60 * 1000

export interface SeasonWindow {
  startsAt: Date
  endsAt: Date
}

/**
 * When the season after one that ended at `previousEndsAt` runs. It starts where the last one stopped,
 * so seasons are back to back; if the job was down so long that this window is over too, it starts now
 * instead of opening a season nobody could have played.
 */
export function nextSeasonWindow(previousEndsAt: Date, now: Date): SeasonWindow {
  let startsAt = previousEndsAt
  let endsAt = new Date(startsAt.getTime() + SEASON_LENGTH_DAYS * DAY_MS)
  if (endsAt.getTime() <= now.getTime()) {
    startsAt = now
    endsAt = new Date(now.getTime() + SEASON_LENGTH_DAYS * DAY_MS)
  }
  return { startsAt, endsAt }
}

export const seasonName = (number: number) => `Season ${number}`

export interface RolloverResult {
  closed: boolean
  seasonId?: string
  seasonNumber?: number
  standings?: number
  opened?: { id: string; number: number }
}

/**
 * Closes the active season if its time is up. Safe to run as often as you like, and from several
 * places at once: a lock serialises runs, and a season that is already closed is not closed again.
 */
export async function closeDueSeason(prisma: PrismaClient, now: Date = new Date()): Promise<RolloverResult> {
  return prisma.$transaction(
    async (tx) => {
      await advisoryLock(tx, 'season-rollover')

      const season = await tx.season.findFirst({ where: { active: true, endsAt: { lte: now } }, orderBy: { number: 'asc' } })
      if (!season) return { closed: false }

      // One statement: the final order is the one the live boards show (score, then user id, both descending),
      // and people who opted out of leaderboards or whose account is gone are not in it.
      const standings = await tx.$executeRaw`
        INSERT INTO "SeasonStanding" ("id", "seasonId", "userId", "rank", "score")
        SELECT gen_random_uuid()::text, ${season.id}, ranked."userId", ranked."rank", ranked."score"
        FROM (
          SELECT e."userId",
                 SUM(e."amount")::int AS "score",
                 ROW_NUMBER() OVER (ORDER BY SUM(e."amount") DESC, e."userId" DESC)::int AS "rank"
          FROM "XPEvent" e
          JOIN "User" u ON u."id" = e."userId" AND u."deletedAt" IS NULL
          LEFT JOIN "Profile" p ON p."userId" = e."userId"
          WHERE e."seasonId" = ${season.id} AND COALESCE(p."hideFromLeaderboards", false) = false
          GROUP BY e."userId"
          HAVING SUM(e."amount") > 0
        ) ranked
        ON CONFLICT ("seasonId", "userId") DO NOTHING
      `

      await tx.season.update({ where: { id: season.id }, data: { active: false, closedAt: now } })

      const window = nextSeasonWindow(season.endsAt, now)
      const next = await tx.season.create({
        data: { number: season.number + 1, name: seasonName(season.number + 1), active: true, ...window },
        select: { id: true, number: true },
      })
      log.info('season closed', { season: season.number, standings, next: next.number })
      return { closed: true, seasonId: season.id, seasonNumber: season.number, standings, opened: next }
    },
    { timeout: 60_000 }
  )
}

export interface SeasonRewardsResult {
  seasonId: string
  seasonNumber: number
  /** People in the final standings. */
  ranked: number
  grants: SeasonCosmeticGrant[]
}

/**
 * Gives a closed season's cosmetics to the people who earned them (see grantSeasonCosmetics) and notes that it was done.
 * Idempotent three ways: a season already marked done is skipped, a lock keeps two runs from doing it at once, and a cosmetic
 * somebody already has is never granted twice. Returns null when there was nothing to do (not closed yet, or done already).
 * No XP is involved: the rewards engine is not called.
 */
export async function grantSeasonRewards(prisma: PrismaClient, seasonId: string, now: Date = new Date()): Promise<SeasonRewardsResult | null> {
  return prisma.$transaction(
    async (tx) => {
      await advisoryLock(tx, `season-rewards:${seasonId}`)
      const season = await tx.season.findUnique({ where: { id: seasonId }, select: { id: true, number: true, closedAt: true, rewardsGrantedAt: true } })
      if (!season || !season.closedAt || season.rewardsGrantedAt) return null
      const grants = await grantSeasonCosmetics(tx, season, now)
      await tx.season.update({ where: { id: season.id }, data: { rewardsGrantedAt: now } })
      const ranked = await tx.seasonStanding.count({ where: { seasonId: season.id } })
      log.info('season rewards granted', { season: season.number, ranked, granted: grants.map((grant) => `${grant.award}:${grant.granted}`).join(' ') })
      return { seasonId: season.id, seasonNumber: season.number, ranked, grants }
    },
    { timeout: 300_000 }
  )
}

/** Grants the rewards of every closed season that has not had them yet, oldest first. The season that just closed is one of them. */
export async function grantPendingSeasonRewards(prisma: PrismaClient, now: Date = new Date()): Promise<SeasonRewardsResult[]> {
  const pending = await prisma.season.findMany({ where: { closedAt: { not: null }, rewardsGrantedAt: null }, orderBy: { number: 'asc' }, select: { id: true } })
  const done: SeasonRewardsResult[] = []
  for (const { id } of pending) {
    const result = await grantSeasonRewards(prisma, id, now)
    if (result) done.push(result)
  }
  return done
}

export interface EnsuredSeason {
  /** `kept`: one was already running. `rolled-over`: the running one was over, so it was closed and the next opened. `created`: there was none at all. */
  action: 'kept' | 'rolled-over' | 'created'
  season: { id: string; number: number; name: string; startsAt: Date; endsAt: Date }
}

const seasonFields = { id: true, number: true, name: true, startsAt: true, endsAt: true } as const

/**
 * Makes sure a season is running, and says what it had to do. A season that is over is closed first (the way the hourly
 * job does it, standings and all). With none running and none to close (a database that never had one, or a gap left by
 * a job that was down), the next one is opened: Season 1 starting now for an empty table, otherwise the one after the
 * last, following on from it. Safe to run any number of times, and from several places at once.
 */
export async function ensureActiveSeason(prisma: PrismaClient, now: Date = new Date()): Promise<EnsuredSeason> {
  const rolled = await closeDueSeason(prisma, now)
  return prisma.$transaction(async (tx) => {
    await advisoryLock(tx, 'season-rollover')
    const running = await tx.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' }, select: seasonFields })
    if (running) return { action: rolled.closed ? ('rolled-over' as const) : ('kept' as const), season: running }

    const last = await tx.season.findFirst({ orderBy: { number: 'desc' }, select: { number: true, endsAt: true } })
    const number = (last?.number ?? 0) + 1
    const window = last ? nextSeasonWindow(last.endsAt, now) : { startsAt: now, endsAt: new Date(now.getTime() + SEASON_LENGTH_DAYS * DAY_MS) }
    const season = await tx.season.create({ data: { number, name: seasonName(number), active: true, ...window }, select: seasonFields })
    log.info('season opened', { season: number })
    return { action: 'created' as const, season }
  })
}

/** The season being played, or null between seasons. */
export async function activeSeason(db: Pick<PrismaClient, 'season'> | Prisma.TransactionClient) {
  return db.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' } })
}

export type RolloverJobResult = RolloverResult & { rewards: SeasonRewardsResult[] }

/** What the scheduled job runs: close the season if its time is up, then grant the cosmetics of every closed season that is owed them. */
export async function runSeasonRollover(): Promise<RolloverJobResult> {
  const { prisma } = await import('@/lib/prisma')
  const closed = await closeDueSeason(prisma)
  return { ...closed, rewards: await grantPendingSeasonRewards(prisma) }
}
