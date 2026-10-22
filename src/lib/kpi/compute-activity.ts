import { Prisma } from '@prisma/client'
import { ACTIVE_EVENTS, MEANINGFUL_EVENTS, OWN_ACTION_XP_TYPES, SHIPPING_EVENTS } from './activity'
import { addDays, dateParam, endOf, mondayOf, startOf, windowStart } from './days'
import { inScope, num, ratio, row, type Db, type MetricRow, type MetricsScope } from './types'

// The numbers about who uses the product and who comes back (docs/METRICS.md, "Activity", "Retention" and "Activation").

// --- Filling the base: ActivityDay -----------------------------------------------------------------------------------------

/**
 * Records who was active on a day (UTC): anyone with a product event in ACTIVE_EVENTS, or XP for an action of their own, that day. Safe to repeat. Returns how many people were
 * added. People whose account is deleted are left out.
 */
export async function fillActivityDay(db: Db, day: string): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "ActivityDay" ("userId", "day")
    SELECT DISTINCT a."userId", ${dateParam(day)} FROM (
      SELECT "userId" FROM "ProductEvent" WHERE "userId" IS NOT NULL AND "name" IN (${Prisma.join(ACTIVE_EVENTS)}) AND "createdAt" >= ${startOf(day)} AND "createdAt" < ${endOf(day)}
      UNION
      SELECT "userId" FROM "XPEvent" WHERE "type" IN (${Prisma.join(OWN_ACTION_XP_TYPES)}) AND "createdAt" >= ${startOf(day)} AND "createdAt" < ${endOf(day)}
    ) a
    JOIN "User" u ON u."id" = a."userId" AND u."deletedAt" IS NULL
    ON CONFLICT DO NOTHING
  `)
}

// --- Activity --------------------------------------------------------------------------------------------------------------

export async function activityMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const [counts] = await db.$queryRaw<{ dau: bigint; wau: bigint; mau: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT a."userId") FILTER (WHERE a."day" = ${dateParam(day)}) AS "dau",
           COUNT(DISTINCT a."userId") FILTER (WHERE a."day" >= ${dateParam(windowStart(day, 7))}) AS "wau",
           COUNT(DISTINCT a."userId") AS "mau"
    FROM "ActivityDay" a JOIN "User" u ON u."id" = a."userId"
    WHERE a."day" >= ${dateParam(windowStart(day, 30))} AND a."day" <= ${dateParam(day)} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const dau = num(counts.dau)
  const wau = num(counts.wau)
  const mau = num(counts.mau)

  const [shippers] = await db.$queryRaw<{ shippers: bigint; posts: bigint; updates: bigint; shipped: bigint }[]>(Prisma.sql`
    WITH window_start AS (SELECT ${startOf(windowStart(day, 7))} AS s, ${endOf(day)} AS e),
    posters AS (SELECT DISTINCT sp."authorId" AS id FROM "ShipPost" sp, window_start w WHERE sp."deletedAt" IS NULL AND sp."moderatedAt" IS NULL AND sp."createdAt" >= w.s AND sp."createdAt" < w.e),
    updaters AS (SELECT DISTINCT pu."authorId" AS id FROM "ProjectUpdate" pu, window_start w WHERE pu."createdAt" >= w.s AND pu."createdAt" < w.e),
    shippedBy AS (SELECT DISTINCT pe."userId" AS id FROM "ProductEvent" pe, window_start w WHERE pe."userId" IS NOT NULL AND pe."name" IN (${Prisma.join(SHIPPING_EVENTS)}) AND pe."createdAt" >= w.s AND pe."createdAt" < w.e),
    everyone AS (SELECT id FROM posters UNION SELECT id FROM updaters UNION SELECT id FROM shippedBy)
    SELECT COUNT(*) FILTER (WHERE TRUE) AS "shippers",
           COUNT(*) FILTER (WHERE e.id IN (SELECT id FROM posters)) AS "posts",
           COUNT(*) FILTER (WHERE e.id IN (SELECT id FROM updaters)) AS "updates",
           COUNT(*) FILTER (WHERE e.id IN (SELECT id FROM shippedBy)) AS "shipped"
    FROM everyone e JOIN "User" u ON u."id" = e.id WHERE u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const was = num(shippers.shippers)

  const [signups] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS "n" FROM "User" u WHERE u."deletedAt" IS NULL AND u."createdAt" >= ${startOf(day)} AND u."createdAt" < ${endOf(day)} AND ${inScope(scope, 'u')}`)
  const [onboarded] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT pe."userId") AS "n" FROM "ProductEvent" pe JOIN "User" u ON u."id" = pe."userId"
    WHERE pe."name" = 'onboarding_completed' AND pe."createdAt" >= ${startOf(day)} AND pe."createdAt" < ${endOf(day)} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}`)
  const [total] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS "n" FROM "User" u WHERE u."deletedAt" IS NULL AND u."createdAt" < ${endOf(day)} AND ${inScope(scope, 'u')}`)

  return [
    ...row('weekly_active_shippers', was, { posts: num(shippers.posts), projectUpdates: num(shippers.updates), shipped: num(shippers.shipped) }),
    ...row('shippers_share_of_wau', ratio(was, wau), { shippers: was, wau }),
    ...row('dau', dau),
    ...row('wau', wau),
    ...row('mau', mau),
    ...row('stickiness_dau_mau', ratio(dau, mau), { dau, mau }),
    ...row('stickiness_wau_mau', ratio(wau, mau), { wau, mau }),
    ...row('signups', num(signups.n)),
    ...row('onboarding_completed', num(onboarded.n)),
    ...row('total_users', num(total.n)),
  ]
}

// --- Retention -------------------------------------------------------------------------------------------------------------

/** Day-N retention of the last 26 weeks of signup cohorts. */
export const RETENTION_DAYS = [1, 7, 30] as const
export const RETENTION_COHORT_WEEKS = 26

/**
 * For each signup week (ISO, UTC) and each of D1, D7 and D30: of the people who signed up that week and whose day N has already passed, the share who were active on exactly their day N
 * after their signup day. A cohort whose day N has not come yet for anyone has no number for it.
 */
export async function retentionMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const firstWeek = addDays(mondayOf(day), -7 * (RETENTION_COHORT_WEEKS - 1))
  const rows = await db.$queryRaw<{ week: string; n: number; cohort: bigint; eligible: bigint; retained: bigint }[]>(Prisma.sql`
    WITH cohort AS (
      SELECT u."id", u."createdAt"::date AS "d0", to_char(u."createdAt", 'IYYY-"W"IW') AS "week"
      FROM "User" u
      WHERE u."deletedAt" IS NULL AND u."createdAt" >= ${startOf(firstWeek)} AND u."createdAt" < ${endOf(day)} AND ${inScope(scope, 'u')}
    )
    SELECT c."week", ns."n", COUNT(*) AS "cohort",
           COUNT(*) FILTER (WHERE c."d0" + ns."n" <= ${dateParam(day)}) AS "eligible",
           COUNT(*) FILTER (WHERE c."d0" + ns."n" <= ${dateParam(day)} AND EXISTS (SELECT 1 FROM "ActivityDay" a WHERE a."userId" = c."id" AND a."day" = c."d0" + ns."n")) AS "retained"
    FROM cohort c CROSS JOIN (VALUES (${RETENTION_DAYS[0]}::int), (${RETENTION_DAYS[1]}::int), (${RETENTION_DAYS[2]}::int)) AS ns("n")
    GROUP BY c."week", ns."n" ORDER BY c."week", ns."n"
  `)
  return rows.flatMap((entry) => row(`retention_d${entry.n}`, ratio(num(entry.retained), num(entry.eligible)), { cohort: num(entry.cohort), eligible: num(entry.eligible), retained: num(entry.retained) }, entry.week))
}

// --- Activation ------------------------------------------------------------------------------------------------------------

export const ACTIVATION_DAYS = 7
export const ACTIVATION_COHORT_WEEKS = 12

/**
 * Of the people who finished onboarding, the share who did a real thing (MEANINGFUL_EVENTS, or XP for an action of their own) within 7 days after finishing it. Only people whose 7 days
 * are over count. One number per completion week, and one for the last four weeks of completions that are old enough (dimension empty).
 */
export async function activationMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const firstWeek = addDays(mondayOf(day), -7 * (ACTIVATION_COHORT_WEEKS - 1))
  // Their 7 days are over when they finished onboarding no later than the start of the day 6 days before D (so that at + 7 days is within D).
  const rows = await db.$queryRaw<{ week: string; trailing: boolean; eligible: bigint; activated: bigint }[]>(Prisma.sql`
    WITH done AS (
      SELECT pe."userId" AS "id", MIN(pe."createdAt") AS "at"
      FROM "ProductEvent" pe JOIN "User" u ON u."id" = pe."userId"
      WHERE pe."name" = 'onboarding_completed' AND pe."userId" IS NOT NULL AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
      GROUP BY pe."userId"
    ), mature AS (
      SELECT d."id", d."at", to_char(d."at", 'IYYY-"W"IW') AS "week", (d."at" >= ${startOf(addDays(day, -34))}) AS "trailing"
      FROM done d
      WHERE d."at" >= ${startOf(firstWeek)} AND d."at" <= ${startOf(addDays(day, -6))}
    )
    SELECT m."week", m."trailing", COUNT(*) AS "eligible",
      COUNT(*) FILTER (WHERE
        EXISTS (SELECT 1 FROM "ProductEvent" p WHERE p."userId" = m."id" AND p."name" IN (${Prisma.join(MEANINGFUL_EVENTS)}) AND p."createdAt" > m."at" AND p."createdAt" <= m."at" + interval '7 days')
        OR EXISTS (SELECT 1 FROM "XPEvent" x WHERE x."userId" = m."id" AND x."type" IN (${Prisma.join(OWN_ACTION_XP_TYPES)}) AND x."createdAt" > m."at" AND x."createdAt" <= m."at" + interval '7 days')
      ) AS "activated"
    FROM mature m GROUP BY m."week", m."trailing"
  `)
  // One number per week (the weeks are split by whether they fall in the trailing window), and one for the trailing window.
  const byWeek = new Map<string, { eligible: number; activated: number }>()
  let trailing = { eligible: 0, activated: 0 }
  for (const entry of rows) {
    const current = byWeek.get(entry.week) ?? { eligible: 0, activated: 0 }
    byWeek.set(entry.week, { eligible: current.eligible + num(entry.eligible), activated: current.activated + num(entry.activated) })
    if (entry.trailing) trailing = { eligible: trailing.eligible + num(entry.eligible), activated: trailing.activated + num(entry.activated) }
  }
  return [
    ...[...byWeek.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([week, counts]) => row('activation_7d', ratio(counts.activated, counts.eligible), { eligible: counts.eligible, activated: counts.activated }, week)),
    ...row('activation_7d', ratio(trailing.activated, trailing.eligible), { eligible: trailing.eligible, activated: trailing.activated }, ''),
  ]
}

/** Of the people who signed up 7 to 34 days ago, the share who finished onboarding within 7 days of signing up. */
export async function onboardingRate(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const [entry] = await db.$queryRaw<{ signups: bigint; finished: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "signups",
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "ProductEvent" pe WHERE pe."userId" = u."id" AND pe."name" = 'onboarding_completed' AND pe."createdAt" <= u."createdAt" + interval '7 days')) AS "finished"
    FROM "User" u
    WHERE u."deletedAt" IS NULL AND u."createdAt" >= ${startOf(addDays(day, -34))} AND u."createdAt" < ${startOf(addDays(day, -6))} AND ${inScope(scope, 'u')}
  `)
  return row('onboarding_7d', ratio(num(entry.finished), num(entry.signups)), { signups: num(entry.signups), finished: num(entry.finished) })
}
