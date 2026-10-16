import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { HeatmapDay } from '@/types/api'
import { DERIVED_XP_TYPES } from '@/lib/rewards-config'
import { utcTimestamp } from '@/lib/sql'
import { addDaysToDateKey, localDateKey, localDateStart, resolveTimeZone } from '@/lib/time'

// The contribution heatmap: the XP a person earned on each local day of their own time zone.
// A day is the owner's day, not the viewer's, so everyone sees the same calendar for a profile.

export const MAX_HEATMAP_DAYS = 365

export interface HeatmapRange {
  timezone: string
  /** First and last local date covered, inclusive. */
  from: string
  to: string
  /** The first instant of `from` in the owner's zone. */
  since: Date
}

/** The `days` local days ending today (so `days: 1` is today alone). */
export function heatmapRange(days: number, timeZone: string | null | undefined, now: Date = new Date()): HeatmapRange {
  const timezone = resolveTimeZone(timeZone)
  const to = localDateKey(now, timezone)
  const from = addDaysToDateKey(to, -(days - 1))
  return { timezone, from, to, since: localDateStart(from, timezone) }
}

/**
 * XP and number of actions per local day, for days that had any. Days with nothing are left out:
 * the response stays small and the client draws the empty squares. `actions` counts what the
 * person did; the XP of an achievement or quest it led to adds to `xp` only.
 */
export async function loadHeatmap(db: Pick<PrismaClient, '$queryRaw'>, userId: string, range: HeatmapRange): Promise<HeatmapDay[]> {
  const rows = await db.$queryRaw<{ date: string; xp: bigint | number; actions: bigint | number }[]>`
    SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${range.timezone}, 'YYYY-MM-DD') AS "date",
           SUM("amount") AS "xp",
           COUNT(*) FILTER (WHERE "type" NOT IN (${Prisma.join(DERIVED_XP_TYPES)})) AS "actions"
    FROM "XPEvent"
    WHERE "userId" = ${userId} AND "createdAt" >= ${utcTimestamp(range.since)}
    GROUP BY 1
    ORDER BY 1
  `
  return rows.map((row) => ({ date: row.date, xp: Number(row.xp), actions: Number(row.actions) }))
}
