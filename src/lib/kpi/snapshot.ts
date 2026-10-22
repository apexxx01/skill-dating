import { Prisma, type PrismaClient } from '@prisma/client'
import { log } from '@/lib/log'
import { activityMetrics, activationMetrics, fillActivityDay, onboardingRate, retentionMetrics } from './compute-activity'
import { deliveryMetrics, growthMetrics, inviteMetrics, safetyMetrics } from './compute-ops'
import { feedMetrics, matchingMetrics, squadMetrics } from './compute-product'
import { addDays, daysBetween, formatDay, isDay, parseDay, yesterday } from './days'
import type { MetricRow, MetricsScope } from './types'

// The nightly job: fills the base (ActivityDay), measures every metric for the day that just ended, and writes the rows (MetricsSnapshot). Each metric group is measured on its own, so
// one that fails (a bad query on an odd database) is logged and left out of the day rather than stopping the others. Safe to repeat: a day's rows are replaced whole.

/** How far back the first run fills ActivityDay from. Later runs fill from where they left off. */
export const FIRST_FILL_DAYS = 90
/** The longest stretch one run fills, whatever it has missed. */
export const MAX_FILL_DAYS = 400

const GROUPS: { name: string; run: (db: PrismaClient, day: string, scope?: MetricsScope) => Promise<MetricRow[]> }[] = [
  { name: 'activity', run: activityMetrics },
  { name: 'retention', run: retentionMetrics },
  { name: 'activation', run: async (db, day, scope) => [...(await activationMetrics(db, day, scope)), ...(await onboardingRate(db, day, scope))] },
  { name: 'matching', run: matchingMetrics },
  { name: 'feed', run: feedMetrics },
  { name: 'squads', run: squadMetrics },
  { name: 'delivery', run: deliveryMetrics },
  { name: 'safety', run: safetyMetrics },
  { name: 'growth', run: growthMetrics },
  { name: 'invites', run: inviteMetrics },
]

export interface MeasureResult {
  rows: MetricRow[]
  failed: string[]
}

/** Every metric for the day, from the database as it is now. Needs ActivityDay filled up to the day. */
export async function measureDay(db: PrismaClient, day: string, scope?: MetricsScope): Promise<MeasureResult> {
  if (!isDay(day)) throw new Error(`not a YYYY-MM-DD day: ${day}`)
  const rows: MetricRow[] = []
  const failed: string[] = []
  for (const group of GROUPS) {
    try {
      rows.push(...(await group.run(db, day, scope)))
    } catch (error) {
      failed.push(group.name)
      log.error('could not measure a group of metrics', { error, group: group.name, day })
    }
  }
  return { rows, failed }
}

/** Fills ActivityDay for the days from `from` to `to`. Returns how many person-days were added. */
export async function fillActivity(db: PrismaClient, from: string, to: string): Promise<number> {
  let added = 0
  for (const day of daysBetween(from, to)) added += await fillActivityDay(db, day)
  return added
}

/**
 * Replaces the day's rows with these. When every group was measured (`complete`) the day is replaced whole; otherwise only the keys that were measured are, so a group that failed keeps
 * what an earlier run of the day wrote.
 */
export async function writeSnapshot(db: PrismaClient, day: string, rows: readonly MetricRow[], complete = true): Promise<void> {
  const date = parseDay(day)
  await db.$transaction(async (tx) => {
    await tx.metricsSnapshot.deleteMany({ where: complete ? { day: date } : { day: date, key: { in: [...new Set(rows.map((entry) => entry.key))] } } })
    await tx.metricsSnapshot.createMany({ data: rows.map((entry) => ({ day: date, key: entry.key, dimension: entry.dimension, value: entry.value, detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined })) })
  })
}

export interface SnapshotOptions {
  /** The day to measure; default the day that just ended (UTC). */
  day?: string
  now?: Date
  /** Fill ActivityDay this many days back at least (the first run does 90). */
  backfillDays?: number
}

export interface SnapshotResult {
  day: string
  rows: number
  failed: string[]
  activityDaysAdded: number
}

export async function runSnapshot(db: PrismaClient, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const day = options.day ?? yesterday(options.now ?? new Date())
  if (!isDay(day)) throw new Error(`not a YYYY-MM-DD day: ${day}`)
  const latest = await db.activityDay.aggregate({ _max: { day: true } })
  const lastFilled = latest._max.day ? formatDay(latest._max.day) : null
  // From the day after the last one filled (the last one again too, in case events landed late), but not further back than a first run or a requested backfill.
  const floor = addDays(day, -Math.min(options.backfillDays ?? FIRST_FILL_DAYS, MAX_FILL_DAYS))
  const from = lastFilled && !options.backfillDays ? (addDays(lastFilled, -1) > floor ? addDays(lastFilled, -1) : floor) : floor
  const filled = await fillActivity(db, from <= day ? from : day, day)

  const { rows, failed } = await measureDay(db, day)
  await writeSnapshot(db, day, rows, failed.length === 0)
  log.info('metrics snapshot', { day, rows: rows.length, failed, filled })
  return { day, rows: rows.length, failed, activityDaysAdded: filled }
}

export async function runSnapshotJob(data: { day?: string; backfillDays?: number }): Promise<SnapshotResult> {
  const { prisma } = await import('@/lib/prisma')
  return runSnapshot(prisma, data)
}
