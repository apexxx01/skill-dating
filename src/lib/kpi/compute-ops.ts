import { Prisma } from '@prisma/client'
import { adultCutoff } from '@/lib/age-policy'
import { MEANINGFUL_EVENTS, OWN_ACTION_XP_TYPES } from './activity'
import { addDays, dateParam, endOf, startOf, windowStart } from './days'
import { inScope, num, ratio, row, type Db, type MetricRow, type MetricsScope } from './types'

// The numbers about reaching people, keeping them safe, where they come from and who brings them (docs/METRICS.md, "Notifications", "Safety", "Growth", "Invites").

// --- Notifications ---------------------------------------------------------------------------------------------------------

/** Where a delivery counts: its channel, except the digests, which are told apart because they are a different thing to open. */
const delivered = Prisma.sql`CASE WHEN d."kind" IN ('DIGEST_DAILY', 'DIGEST_WEEKLY') THEN d."kind" ELSE d."channel"::text END`

/**
 * Of the emails and pushes sent 2 to 30 days ago: the share opened within 48 hours (an email by a click on it, a push by a tap on it), and the share where the person then did something real
 * (MEANINGFUL_EVENTS, or XP for an action of their own) within 30 minutes of opening. And of the email the provider took in that window: the share that bounced, and the share reported as spam.
 */
export async function deliveryMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const window = Prisma.sql`d."sentAt" >= ${startOf(addDays(day, -29))} AND d."sentAt" < ${startOf(addDays(day, -1))}`
  const rows = await db.$queryRaw<{ group: string; sent: bigint; opened: bigint; acted: bigint }[]>(Prisma.sql`
    SELECT ${delivered} AS "group", COUNT(*) AS "sent",
      COUNT(*) FILTER (WHERE d."openedAt" IS NOT NULL AND d."openedAt" <= d."sentAt" + interval '48 hours') AS "opened",
      COUNT(*) FILTER (WHERE d."openedAt" IS NOT NULL AND d."openedAt" <= d."sentAt" + interval '48 hours' AND (
        EXISTS (SELECT 1 FROM "ProductEvent" p WHERE p."userId" = d."userId" AND p."name" IN (${Prisma.join(MEANINGFUL_EVENTS)}) AND p."createdAt" > d."openedAt" AND p."createdAt" <= d."openedAt" + interval '30 minutes')
        OR EXISTS (SELECT 1 FROM "XPEvent" x WHERE x."userId" = d."userId" AND x."type" IN (${Prisma.join(OWN_ACTION_XP_TYPES)}) AND x."createdAt" > d."openedAt" AND x."createdAt" <= d."openedAt" + interval '30 minutes')
      )) AS "acted"
    FROM "NotificationDelivery" d JOIN "User" u ON u."id" = d."userId"
    WHERE d."status" = 'SENT' AND ${window} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
    GROUP BY 1 ORDER BY 1
  `)
  const [mail] = await db.$queryRaw<{ accepted: bigint; bounced: bigint; complained: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "accepted", COUNT(*) FILTER (WHERE d."reason" = 'BOUNCED') AS "bounced", COUNT(*) FILTER (WHERE d."reason" = 'COMPLAINED') AS "complained"
    FROM "NotificationDelivery" d JOIN "User" u ON u."id" = d."userId"
    WHERE d."channel" = 'EMAIL' AND d."providerId" IS NOT NULL AND ${window} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const accepted = num(mail.accepted)
  return [
    ...rows.flatMap((entry) => [
      ...row('delivery_open_rate', ratio(num(entry.opened), num(entry.sent)), { sent: num(entry.sent), opened: num(entry.opened) }, entry.group),
      ...row('delivery_act_rate', ratio(num(entry.acted), num(entry.sent)), { sent: num(entry.sent), acted: num(entry.acted) }, entry.group),
    ]),
    ...row('email_bounce_rate', ratio(num(mail.bounced), accepted), { accepted, bounced: num(mail.bounced) }),
    ...row('email_complaint_rate', ratio(num(mail.complained), accepted), { accepted, complained: num(mail.complained) }),
  ]
}

// --- Safety ----------------------------------------------------------------------------------------------------------------

/**
 * Reports filed by people in the last 7 days per 1,000 people active in them; the median and 90th percentile of the hours from a report to its resolution, for those resolved in the last
 * 28 days; and the reports still open, with the age of the oldest.
 */
export async function safetyMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const [reports] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "n" FROM "Report" r JOIN "User" u ON u."id" = r."reportedId"
    WHERE r."source" = 'USER' AND r."createdAt" >= ${startOf(windowStart(day, 7))} AND r."createdAt" < ${endOf(day)} AND ${inScope(scope, 'u')}
  `)
  const [active] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT a."userId") AS "n" FROM "ActivityDay" a JOIN "User" u ON u."id" = a."userId"
    WHERE a."day" >= ${dateParam(windowStart(day, 7))} AND a."day" <= ${dateParam(day)} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const [times] = await db.$queryRaw<{ resolved: bigint; median: number | null; p90: number | null }[]>(Prisma.sql`
    SELECT COUNT(*) AS "resolved",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."resolvedAt" - r."createdAt")) / 3600.0) AS "median",
      percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."resolvedAt" - r."createdAt")) / 3600.0) AS "p90"
    FROM "Report" r JOIN "User" u ON u."id" = r."reportedId"
    WHERE r."resolvedAt" IS NOT NULL AND r."resolvedAt" >= ${startOf(windowStart(day, 28))} AND r."resolvedAt" < ${endOf(day)} AND ${inScope(scope, 'u')}
  `)
  const [open] = await db.$queryRaw<{ open: bigint; oldest: number | null }[]>(Prisma.sql`
    SELECT COUNT(*) AS "open", MAX(EXTRACT(EPOCH FROM (${endOf(day)} - r."createdAt")) / 3600.0) AS "oldest"
    FROM "Report" r JOIN "User" u ON u."id" = r."reportedId"
    WHERE r."createdAt" < ${endOf(day)} AND (r."resolvedAt" IS NULL OR r."resolvedAt" >= ${endOf(day)}) AND r."status" IN ('PENDING', 'REVIEWING') AND ${inScope(scope, 'u')}
  `)
  const wau = num(active.n)
  return [
    ...row('reports_per_1k_wau', wau > 0 ? (num(reports.n) * 1000) / wau : null, { reports: num(reports.n), wau }),
    ...row('moderation_time_to_action_median_hours', times.median === null ? null : Number(times.median), { resolved: num(times.resolved), p90Hours: times.p90 === null ? null : Number(times.p90) }),
    ...row('moderation_open_reports', num(open.open), { oldestHours: open.oldest === null ? null : Math.round(Number(open.oldest) * 10) / 10 }),
  ]
}

// --- Growth ----------------------------------------------------------------------------------------------------------------

/** A place is not reported below this many people: a count of one or two in a small city or a small campus would point at a person. */
export const PLACE_MINIMUM = 3
const PLACES_PER_KIND = 50

/**
 * Where the people are, by country, city and verified campus (a place is the profile's own; a person with none is in none): everyone who has an account, and everyone who signed up in
 * the last 7 days. Largest first, 50 of each kind, and only places of at least PLACE_MINIMUM people.
 */
export async function growthMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const kinds: [string, Prisma.Sql][] = [
    ['country', Prisma.sql`'country:' || p."countryCode"`],
    ['city', Prisma.sql`'city:' || p."countryCode" || ':' || p."cityKey"`],
    ['campus', Prisma.sql`'campus:' || p."campusKey"`],
  ]
  const conditions: Record<string, Prisma.Sql> = {
    country: Prisma.sql`p."countryCode" IS NOT NULL`,
    city: Prisma.sql`p."countryCode" IS NOT NULL AND p."cityKey" IS NOT NULL`,
    campus: Prisma.sql`p."campusKey" IS NOT NULL`,
  }
  const out: MetricRow[] = []
  for (const [kind, place] of kinds) {
    const rows = await db.$queryRaw<{ place: string; total: bigint; recent: bigint }[]>(Prisma.sql`
      SELECT ${place} AS "place", COUNT(*) AS "total", COUNT(*) FILTER (WHERE u."createdAt" >= ${startOf(windowStart(day, 7))}) AS "recent"
      FROM "Profile" p JOIN "User" u ON u."id" = p."userId"
      WHERE u."deletedAt" IS NULL AND u."createdAt" < ${endOf(day)} AND ${conditions[kind]} AND ${inScope(scope, 'u')}
      GROUP BY 1 HAVING COUNT(*) >= ${PLACE_MINIMUM} ORDER BY COUNT(*) DESC, 1 ASC LIMIT ${PLACES_PER_KIND}
    `)
    for (const entry of rows) {
      out.push(...row('users_by_place', num(entry.total), undefined, entry.place))
      if (num(entry.recent) > 0) out.push(...row('signups_7d_by_place', num(entry.recent), undefined, entry.place))
    }
  }
  return out
}

// --- Demand for the romance mode -------------------------------------------------------------------------------------------

/**
 * Who has asked to be told when the romance mode opens (POST /api/romance/interest), the demand signal that decides where it opens first: the total, by city (the country and city
 * kept with the request; 50 largest, and only cities of at least PLACE_MINIMUM people, as with every place), and each as a share of the ADULTS who were active in the last 30 days
 * in the same place. The share can pass 1: a person can ask without having been active lately. These are the only numbers that mention the mode; they read one table and no
 * activity of the mode, which has none yet.
 */
export async function demandMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const adults = Prisma.sql`u."birthDate" IS NOT NULL AND u."birthDate" <= ${adultCutoff(new Date(`${day}T12:00:00Z`))}::date`
  const [totals] = await db.$queryRaw<{ interested: bigint; actives: bigint }[]>(Prisma.sql`
    SELECT
      (SELECT COUNT(*) FROM "RomanceInterest" i JOIN "User" u ON u."id" = i."userId" WHERE u."deletedAt" IS NULL AND i."createdAt" < ${endOf(day)} AND ${inScope(scope, 'u')}) AS "interested",
      (SELECT COUNT(DISTINCT a."userId") FROM "ActivityDay" a JOIN "User" u ON u."id" = a."userId"
        WHERE a."day" >= ${dateParam(windowStart(day, 30))} AND a."day" <= ${dateParam(day)} AND u."deletedAt" IS NULL AND ${adults} AND ${inScope(scope, 'u')}) AS "actives"
  `)
  const out: MetricRow[] = [
    ...row('romance_interest', num(totals.interested)),
    ...row('romance_interest_share_of_adult_actives', ratio(num(totals.interested), num(totals.actives)), { interested: num(totals.interested), adultActives: num(totals.actives) }),
  ]
  const cities = await db.$queryRaw<{ place: string; interested: bigint; actives: bigint }[]>(Prisma.sql`
    WITH asked AS (
      SELECT 'city:' || i."countryCode" || ':' || i."cityKey" AS "place", COUNT(*) AS "interested"
      FROM "RomanceInterest" i JOIN "User" u ON u."id" = i."userId"
      WHERE u."deletedAt" IS NULL AND i."createdAt" < ${endOf(day)} AND i."countryCode" IS NOT NULL AND i."cityKey" IS NOT NULL AND ${inScope(scope, 'u')}
      GROUP BY 1 HAVING COUNT(*) >= ${PLACE_MINIMUM} ORDER BY COUNT(*) DESC, 1 ASC LIMIT ${PLACES_PER_KIND}
    )
    SELECT asked."place", asked."interested",
      (SELECT COUNT(DISTINCT a."userId") FROM "ActivityDay" a JOIN "User" u ON u."id" = a."userId" JOIN "Profile" p ON p."userId" = u."id"
        WHERE a."day" >= ${dateParam(windowStart(day, 30))} AND a."day" <= ${dateParam(day)} AND u."deletedAt" IS NULL AND ${adults}
          AND 'city:' || p."countryCode" || ':' || p."cityKey" = asked."place" AND ${inScope(scope, 'u')}) AS "actives"
    FROM asked ORDER BY asked."interested" DESC, asked."place" ASC
  `)
  for (const entry of cities) {
    out.push(...row('romance_interest', num(entry.interested), undefined, entry.place))
    out.push(...row('romance_interest_share_of_adult_actives', ratio(num(entry.interested), num(entry.actives)), { interested: num(entry.interested), adultActives: num(entry.actives) }, entry.place))
  }
  return out
}

// --- Invites ---------------------------------------------------------------------------------------------------------------

/**
 * Invites redeemed in the last 28 days per person active in the last 30 (invites per active user); and, of the invites redeemed 14 to 41 days before the end of D, the share whose invitee got started
 * (finished onboarding and did a first real thing) within 14 days of joining: in all, and for personal and campaign codes apart.
 */
export async function inviteMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const [redeemed] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "n" FROM "InviteRedemption" r JOIN "User" u ON u."id" = r."inviteeId"
    WHERE r."redeemedAt" >= ${startOf(windowStart(day, 28))} AND r."redeemedAt" < ${endOf(day)} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const [mau] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT a."userId") AS "n" FROM "ActivityDay" a JOIN "User" u ON u."id" = a."userId"
    WHERE a."day" >= ${dateParam(windowStart(day, 30))} AND a."day" <= ${dateParam(day)} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const rows = await db.$queryRaw<{ kind: string; redeemed: bigint; started: bigint }[]>(Prisma.sql`
    SELECT c."kind"::text AS "kind", COUNT(*) AS "redeemed",
      COUNT(*) FILTER (WHERE r."qualifiedAt" IS NOT NULL AND r."qualifiedAt" <= r."redeemedAt" + interval '14 days') AS "started"
    FROM "InviteRedemption" r JOIN "InviteCode" c ON c."id" = r."codeId" JOIN "User" u ON u."id" = r."inviteeId"
    WHERE r."redeemedAt" >= ${startOf(addDays(day, -41))} AND r."redeemedAt" < ${startOf(addDays(day, -13))} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
    GROUP BY 1
  `)
  const total = rows.reduce((sum, entry) => sum + num(entry.redeemed), 0)
  const started = rows.reduce((sum, entry) => sum + num(entry.started), 0)
  return [
    ...row('invites_per_active_user_28d', ratio(num(redeemed.n), num(mau.n)), { redeemed: num(redeemed.n), mau: num(mau.n) }),
    ...row('invite_conversion_14d', ratio(started, total), { redeemed: total, started }),
    ...rows.flatMap((entry) => row('invite_conversion_14d', ratio(num(entry.started), num(entry.redeemed)), { redeemed: num(entry.redeemed), started: num(entry.started) }, entry.kind)),
  ]
}
