import { notHighRisk, notMutedBy, notRestricted } from '@/lib/integrity/reach-sql'
import { Prisma, type PrismaClient } from '@prisma/client'
import { birthDateCutoffForAge } from '@/lib/age'
import { datingEligibleSql } from '@/lib/matching/dating'
import { MIN_TRUSTED_ACCOUNT_AGE_DAYS } from '@/lib/trust'
import { utcTimestamp } from '@/lib/sql'
import { ROMANCE_CONFIG, type Gender, type Scope } from './config'

// The candidate pool for one person's romance drop, in SQL. This is the only place that decides who may be SHOWN to whom in the romance mode, and
// it is the SQL form of two pure rules: mutual acceptance of the private filters (filters.ts) and the gates (the 18+ rule, a verified person,
// a trusted account). The integration test compares the two over every combination.
//
//   RomanceProfile ⋈ User ⋈ Profile, narrowed by
//     - not paused, not deleted, seen in the last 60 days, a trusted account (verified email, a week old), 18 or older, and a phone or GitHub;
//     - the viewer's filters accept the candidate (gender, age range, scope) AND the candidate's filters accept the viewer;
//     - the candidate's inbox gate: the viewer has at least as many trusted endorsers as the candidate asks for;
//     - not blocked either way, not already matched with the viewer for romance, and not a pair whose match of any kind ended (unmatching is final), not already sparked by them;
//     - not shown to the viewer in the last `repeatCooldownDays` days, and not already shown to `exposureCapPerWeek` people this week;
//   ordered by a cheap pre-rank (recently active first) and cut to a bounded pool, which the pure scorer ranks.
//
// The romance mode never reads the professional pool (matching/candidates.ts) and that pool never reads this one: they are different tables.

type Db = Pick<PrismaClient, '$queryRaw'>

export interface RomanceViewer {
  userId: string
  gender: Gender
  interestedIn: readonly Gender[]
  ageMin: number
  ageMax: number
  scope: Scope
  /** Whole years old today. */
  age: number
  cityKey: string | null
  countryCode: string | null
  /** Trusted endorsers they have (the inbox gate of the people they are shown). */
  endorsers: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export interface RomancePoolOptions {
  /** Only these people (checking one person against the same rules). */
  onlyIds?: readonly string[]
  /** Forget what the viewer was shown lately (a rule check, not a drop). */
  ignoreHistory?: boolean
  limit?: number
}

export async function findRomanceCandidateIds(db: Db, viewer: RomanceViewer, now: Date, options: RomancePoolOptions = {}): Promise<string[]> {
  const config = ROMANCE_CONFIG.drop
  const trustedBefore = utcTimestamp(new Date(now.getTime() - MIN_TRUSTED_ACCOUNT_AGE_DAYS * DAY_MS))
  const activeSince = utcTimestamp(new Date(now.getTime() - config.activeWithinDays * DAY_MS))
  const repeatSince = utcTimestamp(new Date(now.getTime() - config.repeatCooldownDays * DAY_MS))
  const weekAgo = utcTimestamp(new Date(now.getTime() - WEEK_MS))
  // Born on or before `oldest`... : the candidate's age is inside [ageMin, ageMax] when they were born after the cutoff for ageMax + 1 and on or before the one for ageMin.
  const bornOnOrBefore = birthDateCutoffForAge(viewer.ageMin, now)
  const bornAfter = birthDateCutoffForAge(viewer.ageMax + 1, now)
  const interested = [...viewer.interestedIn]
  // 18 or older, a verified email, and a phone or GitHub: the one gate (src/lib/matching/dating.ts).
  const datingEligible = datingEligibleSql('u', now)
  const only = options.onlyIds ? Prisma.sql`AND u."id" = ANY(${[...options.onlyIds]}::text[])` : Prisma.empty
  const history = options.ignoreHistory
    ? Prisma.empty
    : Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "RomanceDrop" d WHERE d."userId" = ${viewer.userId} AND d."candidateId" = u."id" AND d."createdAt" >= ${repeatSince})`
  const exposure = options.ignoreHistory
    ? Prisma.empty
    : Prisma.sql`AND (SELECT COUNT(*) FROM "RomanceDrop" e WHERE e."candidateId" = u."id" AND e."createdAt" >= ${weekAgo}) < ${config.exposureCapPerWeek}`

  // The viewer's own scope, against where each candidate is.
  const viewerScope =
    viewer.scope === 'ANYWHERE'
      ? Prisma.sql`TRUE`
      : viewer.scope === 'CITY'
        ? Prisma.sql`(${viewer.cityKey}::text IS NOT NULL AND p."cityKey" = ${viewer.cityKey})`
        : Prisma.sql`(${viewer.countryCode}::text IS NOT NULL AND p."countryCode" = ${viewer.countryCode})`
  // The candidate's scope, against where the viewer is.
  const candidateScope = Prisma.sql`(
    rp."scope" = 'ANYWHERE'
    OR (rp."scope" = 'CITY' AND ${viewer.cityKey}::text IS NOT NULL AND p."cityKey" = ${viewer.cityKey})
    OR (rp."scope" = 'COUNTRY' AND ${viewer.countryCode}::text IS NOT NULL AND p."countryCode" = ${viewer.countryCode})
  )`

  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u."id"
    FROM "RomanceProfile" rp
    JOIN "User" u ON u."id" = rp."userId"
    LEFT JOIN "Profile" p ON p."userId" = u."id"
    WHERE rp."userId" <> ${viewer.userId}
      AND rp."paused" = false
      AND u."deletedAt" IS NULL
      AND u."isEmailVerified" = true
      AND u."createdAt" <= ${trustedBefore}
      AND u."lastActiveAt" >= ${activeSince}
      AND ${datingEligible}
      -- the viewer accepts the candidate
      AND rp."gender" = ANY(${interested}::"RomanceGender"[])
      AND u."birthDate" <= ${bornOnOrBefore}::date AND u."birthDate" > ${bornAfter}::date
      AND ${viewerScope}
      -- the candidate accepts the viewer
      AND ${viewer.gender}::"RomanceGender" = ANY(rp."interestedIn")
      AND ${viewer.age} BETWEEN rp."ageMin" AND rp."ageMax"
      AND ${candidateScope}
      AND rp."minEndorsements" <= ${viewer.endorsers}
      AND rp."moderatedAt" IS NULL
      AND ${notHighRisk('u')}
      AND ${notRestricted('u', now, ['ROMANCE'])}
      AND ${notMutedBy('u', viewer.userId)}
      AND NOT EXISTS (
        SELECT 1 FROM "Block" b
        WHERE (b."blockerId" = ${viewer.userId} AND b."blockedId" = u."id") OR (b."blockerId" = u."id" AND b."blockedId" = ${viewer.userId})
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Match" m WHERE m."userAId" = LEAST(${viewer.userId}, u."id") AND m."userBId" = GREATEST(${viewer.userId}, u."id") AND (m."connectionType" = 'DATING' OR m."endedAt" IS NOT NULL)
      )
      AND NOT EXISTS (SELECT 1 FROM "Spark" sp WHERE sp."fromId" = ${viewer.userId} AND sp."toId" = u."id" AND sp."connectionType" = 'DATING')
      ${history}
      ${exposure}
      ${only}
    ORDER BY u."lastActiveAt" DESC, u."id"
    LIMIT ${options.limit ?? config.candidatePool}
  `)
  return rows.map((row) => row.id)
}
