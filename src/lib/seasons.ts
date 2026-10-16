import { Prisma, type PrismaClient } from '@prisma/client'
import { advisoryLock } from '@/lib/progress'
import { log } from '@/lib/log'

// Seasons: fixed stretches of time with their own leaderboard. Exactly one is active at a time.
// grant() stamps every XPEvent with the active season, so a season's standings are always the sum of
// the XP stamped with it. The rollover job (src/lib/infra/jobs.ts, hourly) closes the season whose
// time is up: it writes the final standings once, deactivates it and opens the next one in the same
// transaction. Nothing is paid for a placing yet; SeasonStanding is the record rewards will use.

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

/** The season being played, or null between seasons. */
export async function activeSeason(db: Pick<PrismaClient, 'season'> | Prisma.TransactionClient) {
  return db.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' } })
}

/** What the scheduled job runs. */
export async function runSeasonRollover(): Promise<RolloverResult> {
  const { prisma } = await import('@/lib/prisma')
  return closeDueSeason(prisma)
}
