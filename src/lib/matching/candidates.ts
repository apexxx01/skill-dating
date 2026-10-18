import { Prisma, type PrismaClient } from '@prisma/client'
import { MIN_TRUSTED_ACCOUNT_AGE_DAYS } from '@/lib/trust'
import { utcTimestamp } from '@/lib/sql'
import { DROP_CONFIG } from './config'
import { counterpartType, type MatchType } from './types'

// The candidate pool for one viewer and one type of relationship, in SQL. This is the only place that decides who may be SHOWN to
// whom, and it is built from the indexes, so the work does not grow with the number of accounts but with the number of people who
// could really fit:
//
//   MatchingProfile ⋈ User ⋈ Profile, narrowed by
//     - the type: the candidate has the counterpart of the viewer's type (GIN on connectionTypes);
//     - not paused, not deleted, seen in the last 60 days (User.lastActiveAt);
//     - a trusted account: email verified and at least 7 days old, the same rule as the trusted-counterparty gate;
//     - not blocked either way (Block, both directions);
//     - not already matched with the viewer (open or ended: unmatching is final) and not already sparked by them;
//     - not shown to this viewer lately, and not passed in the last 30 days (Drop (userId, candidateId, createdAt));
//     - not already shown to enough people today (Drop (candidateId, createdAt)): the fairness cap;
//     - the "only my city" wish of either side.
//   ordered by a cheap pre-rank (skills each wants that the other has, then recency) and cut to a bounded pool, which the pure scorer ranks.
//
// The pool is for the professional types only. The romance mode has its own pool (src/lib/romance/candidates.ts) over its own table, so
// the two never mix.

type Db = Pick<PrismaClient, '$queryRaw'>

export interface Viewer {
  userId: string
  cityOnly: boolean
  cityKey: string | null
  /** Ids of the skills the viewer is looking for (resolved from their slugs once, so the ranking is an index lookup per candidate). */
  lookingForSkillIds: readonly string[]
  /** Skill slugs the viewer has, for what other people are looking for. */
  skillSlugs: readonly string[]
}

/**
 * How the pool differs from a plain daily drop. All of it narrows or widens what is remembered about the viewer's past with a person; nothing here
 * loosens who may be shown (blocks, trust, pausing and the exposure cap always apply).
 */
export interface PoolOptions {
  /** Only these people (a second look at someone already known). */
  onlyIds?: readonly string[]
  /** Never these people (a team's members and applicants). */
  excludeIds?: readonly string[]
  /** Forget what the viewer was shown or passed lately: the second look is exactly about somebody they passed. */
  ignoreHistory?: boolean
  /**
   * For suggestions to a team's owner rather than a drop: somebody shown lately, already sparked or currently matched with them stays in (a matched person is a
   * good person to invite), while a match that ended is still final, and somebody they passed in the last 30 days is still left out.
   */
  teamSuggestion?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The first instant of the UTC day that `now` is in: the window the exposure cap counts in. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export async function findCandidateIds(
  db: Db,
  viewer: Viewer,
  type: MatchType,
  now: Date,
  config: typeof DROP_CONFIG = DROP_CONFIG,
  options: PoolOptions = {}
): Promise<string[]> {
  const counterpart = counterpartType(type)
  const trustedBefore = utcTimestamp(new Date(now.getTime() - MIN_TRUSTED_ACCOUNT_AGE_DAYS * DAY_MS))
  const activeSince = utcTimestamp(new Date(now.getTime() - config.activeWithinDays * DAY_MS))
  const dayStart = utcTimestamp(utcDayStart(now))
  const repeatSince = utcTimestamp(new Date(now.getTime() - config.repeatCooldownDays * DAY_MS))
  const passedSince = utcTimestamp(new Date(now.getTime() - config.passCooldownDays * DAY_MS))
  const wants = [...viewer.lookingForSkillIds]
  const has = [...viewer.skillSlugs]

  const team = options.teamSuggestion === true
  const only = options.onlyIds ? Prisma.sql`AND u."id" = ANY(${[...options.onlyIds]}::text[])` : Prisma.empty
  const except = options.excludeIds && options.excludeIds.length > 0 ? Prisma.sql`AND NOT (u."id" = ANY(${[...options.excludeIds]}::text[]))` : Prisma.empty
  // A match that ended is final everywhere; one that is open (or a spark already sent) only keeps the person out of a drop.
  const matchClause = team ? Prisma.sql`AND m."endedAt" IS NOT NULL` : Prisma.empty
  const sparkClause = team ? Prisma.sql`AND FALSE` : Prisma.empty
  // What the viewer was shown and passed: a team suggestion keeps only the 30 day pass; a second look keeps nothing.
  const historyClause = options.ignoreHistory
    ? Prisma.sql`AND FALSE`
    : team
      ? Prisma.sql`AND d."status" = 'PASSED' AND d."updatedAt" >= ${passedSince}`
      : Prisma.sql`AND (d."createdAt" >= ${repeatSince} OR (d."status" = 'PASSED' AND d."updatedAt" >= ${passedSince}))`

  // Three steps, so the expensive per-candidate work only ever sees a bounded set:
  //   base   - the cheap filters, as hash joins and anti-joins: the cost is the number of people of this type who were active lately;
  //   hits   - how many of the skills the viewer is looking for each person has: one index scan on UserSkill(skillId), not a lookup per candidate;
  //   ranked - base ranked by those hits (and whether the candidate is looking for something the viewer has), then recency, cut to twice the pool;
  // and last the exposure cap, an index lookup per remaining candidate, cut to the pool.
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH base AS MATERIALIZED (
      SELECT u."id", u."lastActiveAt", (mp."lookingForSkills" && ${has}::text[]) AS "theyNeedMe"
      FROM "MatchingProfile" mp
      JOIN "User" u ON u."id" = mp."userId"
      LEFT JOIN "Profile" p ON p."userId" = u."id"
      WHERE mp."userId" <> ${viewer.userId}
        AND mp."paused" = false
        AND mp."connectionTypes" @> ARRAY[${counterpart}::"MatchType"]
        AND u."deletedAt" IS NULL
        AND u."isEmailVerified" = true
        AND u."createdAt" <= ${trustedBefore}
        AND u."lastActiveAt" >= ${activeSince}
        AND (${viewer.cityOnly} = false OR p."cityKey" = ${viewer.cityKey})
        AND (mp."cityOnly" = false OR (${viewer.cityKey}::text IS NOT NULL AND p."cityKey" = ${viewer.cityKey}))
        AND NOT EXISTS (
          SELECT 1 FROM "Block" b
          WHERE (b."blockerId" = ${viewer.userId} AND b."blockedId" = u."id") OR (b."blockerId" = u."id" AND b."blockedId" = ${viewer.userId})
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Match" m WHERE m."userAId" = LEAST(${viewer.userId}, u."id") AND m."userBId" = GREATEST(${viewer.userId}, u."id") ${matchClause}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Spark" sp WHERE sp."fromId" = ${viewer.userId} AND sp."toId" = u."id" ${sparkClause}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Drop" d
          WHERE d."userId" = ${viewer.userId} AND d."candidateId" = u."id" ${historyClause}
        )
        ${only}
        ${except}
    ),
    hits AS (
      SELECT us."userId", COUNT(*) AS "n" FROM "UserSkill" us WHERE us."skillId" = ANY(${wants}::text[]) GROUP BY us."userId"
    ),
    ranked AS (
      SELECT b."id", b."lastActiveAt", COALESCE(h."n", 0) + CASE WHEN b."theyNeedMe" THEN 1 ELSE 0 END AS "relevance"
      FROM base b LEFT JOIN hits h ON h."userId" = b."id"
      ORDER BY "relevance" DESC, b."lastActiveAt" DESC, b."id"
      LIMIT ${config.candidatePoolPerType * 2}
    )
    SELECT r."id"
    FROM ranked r
    WHERE (SELECT COUNT(*) FROM "Drop" e WHERE e."candidateId" = r."id" AND e."createdAt" >= ${dayStart}) < ${config.exposureCapPerDay}
    ORDER BY r."relevance" DESC, r."lastActiveAt" DESC, r."id"
    LIMIT ${config.candidatePoolPerType}
  `
  return rows.map((row) => row.id)
}

/** A Viewer from a person's matching profile: the skills they look for are looked up by slug once, so the pool query ranks by id. */
export async function viewerFor(
  db: Pick<PrismaClient, 'skill'>,
  person: { userId: string; cityOnly: boolean; cityKey: string | null; lookingForSkills: readonly string[]; skillSlugs: readonly string[] }
): Promise<Viewer> {
  const wanted = person.lookingForSkills.length > 0 ? await db.skill.findMany({ where: { slug: { in: [...person.lookingForSkills] } }, select: { id: true } }) : []
  return { userId: person.userId, cityOnly: person.cityOnly, cityKey: person.cityKey, lookingForSkillIds: wanted.map((skill) => skill.id), skillSlugs: person.skillSlugs }
}
