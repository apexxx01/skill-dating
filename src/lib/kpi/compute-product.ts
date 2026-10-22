import { Prisma } from '@prisma/client'
import { addDays, endOf, startOf, windowStart } from './days'
import { inScope, num, ratio, row, type Db, type MetricRow, type MetricsScope } from './types'

// The numbers about what people do with the product: matching, the feed, hackathon squads, crews (docs/METRICS.md, "Matching", "Feed", "Squads and crews"). The romance mode is not read:
// every matching number is about the professional kinds (a spark or a match whose connectionType is DATING is left out).

// --- Matching --------------------------------------------------------------------------------------------------------------

/**
 * Of the professional sparks sent 7 to 34 days ago (so each has had a week to be answered), the share that became a match. Of the professional matches made in the same window,
 * the share in which anybody wrote a first message (not the platform's own icebreaker) within 7 days of the match.
 */
export async function matchingMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const from = startOf(addDays(day, -34))
  const to = startOf(addDays(day, -6))
  const [sparks] = await db.$queryRaw<{ sent: bigint; matched: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "sent", COUNT(*) FILTER (WHERE s."status" = 'MATCHED') AS "matched"
    FROM "Spark" s JOIN "User" u ON u."id" = s."fromId"
    WHERE s."connectionType" <> 'DATING' AND s."createdAt" >= ${from} AND s."createdAt" < ${to} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const [matches] = await db.$queryRaw<{ made: bigint; talked: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "made",
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "Message" m WHERE m."conversationId" = x."conversationId" AND m."type" <> 'SYSTEM' AND m."deletedAt" IS NULL AND m."createdAt" > x."createdAt" AND m."createdAt" <= x."createdAt" + interval '7 days'
      )) AS "talked"
    FROM "Match" x JOIN "User" u ON u."id" = x."userAId"
    WHERE x."connectionType" <> 'DATING' AND x."conversationId" IS NOT NULL AND x."createdAt" >= ${from} AND x."createdAt" < ${to} AND ${inScope(scope, 'u')}
  `)
  // Drops that have all had their day (created 1 to 8 days ago): the share that were looked at, and the share that were answered with a spark or a pass.
  const [drops] = await db.$queryRaw<{ shown: bigint; viewed: bigint; acted: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "shown", COUNT(*) FILTER (WHERE d."viewedAt" IS NOT NULL) AS "viewed", COUNT(*) FILTER (WHERE d."status" IN ('SPARKED', 'PASSED')) AS "acted"
    FROM "Drop" d JOIN "User" u ON u."id" = d."userId"
    WHERE d."createdAt" >= ${startOf(windowStart(addDays(day, -1), 8))} AND d."createdAt" < ${endOf(addDays(day, -1))} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const shown = num(drops.shown)
  return [
    ...row('spark_to_match_rate', ratio(num(sparks.matched), num(sparks.sent)), { sparks: num(sparks.sent), matched: num(sparks.matched) }),
    ...row('match_to_first_message_rate', ratio(num(matches.talked), num(matches.made)), { matches: num(matches.made), talked: num(matches.talked) }),
    ...row('drops_viewed_rate', ratio(num(drops.viewed), shown), { drops: shown, viewed: num(drops.viewed) }),
    ...row('drops_acted_rate', ratio(num(drops.acted), shown), { drops: shown, acted: num(drops.acted) }),
  ]
}

// --- The feed --------------------------------------------------------------------------------------------------------------

/** Props per post: of the posts made 3 to 9 days ago (a few days to be noticed in), the Props they got divided by how many there are. */
export async function feedMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const [posts] = await db.$queryRaw<{ posts: bigint; props: bigint | null }[]>(Prisma.sql`
    SELECT COUNT(*) AS "posts", SUM(sp."propsCount") AS "props"
    FROM "ShipPost" sp JOIN "User" u ON u."id" = sp."authorId"
    WHERE sp."deletedAt" IS NULL AND sp."moderatedAt" IS NULL AND sp."createdAt" >= ${startOf(addDays(day, -9))} AND sp."createdAt" < ${startOf(addDays(day, -2))} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const count = num(posts.posts)

  // Ship Day: of the people active in the week up to the latest Ship Day, the share who posted on it. The Friday is the recap's own date.
  const recaps = await db.$queryRaw<{ weekKey: string; dateKey: string }[]>(Prisma.sql`
    SELECT "weekKey", "dateKey" FROM "ShipDayRecap" WHERE "createdAt" < ${endOf(day)} ORDER BY "createdAt" DESC LIMIT 1
  `)
  let shipDay: MetricRow[] = []
  if (recaps.length > 0) {
    const { weekKey, dateKey } = recaps[0]
    const [posted] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT sp."authorId") AS "n" FROM "ShipPost" sp JOIN "User" u ON u."id" = sp."authorId"
      WHERE sp."shipDayKey" = ${dateKey} AND sp."deletedAt" IS NULL AND sp."moderatedAt" IS NULL AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}`)
    const [active] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT a."userId") AS "n" FROM "ActivityDay" a JOIN "User" u ON u."id" = a."userId"
      WHERE a."day" >= ${Prisma.sql`${addDays(dateKey, -6)}::date`} AND a."day" <= ${Prisma.sql`${dateKey}::date`} AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}`)
    shipDay = row('ship_day_participation', ratio(num(posted.n), num(active.n)), { posted: num(posted.n), active: num(active.n) }, weekKey)
  }
  return [...row('props_per_post', ratio(num(posts.props), count), { posts: count, props: num(posts.props) }), ...shipDay]
}

// --- Squads and crews ------------------------------------------------------------------------------------------------------

/**
 * Hackathons that ended in the last 90 days: the share of their registered people (not those who withdrew) who ended in a squad; the median and the 90th percentile of the hours
 * from registering to joining a squad, for those who joined one; and the share of their squads that submitted.
 */
export async function squadMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const ended = Prisma.sql`h."endDate" < ${endOf(day)} AND h."endDate" >= ${startOf(addDays(day, -89))} AND h."status" <> 'CANCELLED' AND h."moderatedAt" IS NULL`
  const [people] = await db.$queryRaw<{ hackathons: bigint; registered: bigint; inSquad: bigint; median: number | null; p90: number | null }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT p."hackathonId") AS "hackathons", COUNT(*) AS "registered", COUNT(*) FILTER (WHERE p."teamId" IS NOT NULL) AS "inSquad",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p."teamJoinedAt" - p."registeredAt")) / 3600.0) FILTER (WHERE p."teamJoinedAt" IS NOT NULL) AS "median",
      percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p."teamJoinedAt" - p."registeredAt")) / 3600.0) FILTER (WHERE p."teamJoinedAt" IS NOT NULL) AS "p90"
    FROM "HackathonParticipant" p JOIN "Hackathon" h ON h."id" = p."hackathonId" JOIN "User" u ON u."id" = p."userId"
    WHERE ${ended} AND p."status" <> 'WITHDRAWN' AND u."deletedAt" IS NULL AND ${inScope(scope, 'u')}
  `)
  const [squads] = await db.$queryRaw<{ squads: bigint; submitted: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "squads",
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "HackathonParticipant" p WHERE p."teamId" = ht."teamId" AND p."status" = 'SUBMITTED')) AS "submitted"
    FROM "HackathonTeam" ht JOIN "Hackathon" h ON h."id" = ht."hackathonId" JOIN "Team" t ON t."id" = ht."teamId" JOIN "User" o ON o."id" = t."ownerId"
    WHERE ${ended} AND o."deletedAt" IS NULL AND ${inScope(scope, 'o')}
  `)
  const registered = num(people.registered)
  const joined = num(people.inSquad)
  return [
    ...row('hackathon_squad_rate', ratio(joined, registered), { hackathons: num(people.hackathons), registered, inSquad: joined }),
    ...row('time_to_squad_median_hours', people.median === null ? null : Number(people.median), { p90Hours: people.p90 === null ? null : Number(people.p90), inSquad: joined }),
    ...row('squads_submitted_rate', ratio(num(squads.submitted), num(squads.squads)), { squads: num(squads.squads), submitted: num(squads.submitted) }),
    ...(await crewMetrics(db, day, scope)),
  ]
}

/**
 * Crews (teams) made 30 to 59 days ago: the share that shipped within 30 days of being made. A crew shipped when it posted to the feed (a post of the crew, or of its project), or its project
 * was marked shipped.
 */
async function crewMetrics(db: Db, day: string, scope?: MetricsScope): Promise<MetricRow[]> {
  const [crews] = await db.$queryRaw<{ crews: bigint; shipped: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS "crews",
      COUNT(*) FILTER (WHERE
        EXISTS (SELECT 1 FROM "ShipPost" sp WHERE sp."deletedAt" IS NULL AND sp."moderatedAt" IS NULL AND sp."createdAt" <= t."createdAt" + interval '30 days' AND (sp."teamId" = t."id" OR (t."projectId" IS NOT NULL AND sp."projectId" = t."projectId")))
        OR EXISTS (SELECT 1 FROM "Project" pr WHERE pr."id" = t."projectId" AND pr."shippedAt" IS NOT NULL AND pr."shippedAt" <= t."createdAt" + interval '30 days')
      ) AS "shipped"
    FROM "Team" t JOIN "User" o ON o."id" = t."ownerId"
    WHERE t."createdAt" >= ${startOf(addDays(day, -59))} AND t."createdAt" < ${startOf(addDays(day, -29))} AND o."deletedAt" IS NULL AND ${inScope(scope, 'o')}
  `)
  return row('crews_shipped_30d_rate', ratio(num(crews.shipped), num(crews.crews)), { crews: num(crews.crews), shipped: num(crews.shipped) })
}
