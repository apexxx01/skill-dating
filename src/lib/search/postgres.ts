import { Prisma, type PrismaClient } from '@prisma/client'
import { notHighRisk, notRestricted } from '@/lib/integrity/reach-sql'
import { likePrefix, prefixTsQuery } from './query'
import { HIT_TYPE, TYPE_ORDER, type CrewHit, type HackathonHit, type PostHit, type ProjectHit, type RankedHit, type SearchPage, type SearchProvider, type SearchQuery, type SearchScope, type SearchType, type UserHit } from './types'

// The PostgreSQL search provider (docs/SEARCH.md). One query per type, each returning at most one page, merged here by (score, type, id): the same order the cursor
// keys on. Everything a person may not see is in the WHERE of the query, never applied to a page afterwards, so a page is never short and a cursor never skips.
//
// Matching, three ways at once (migration 20261022000300_search has the indexes):
//   prefix        every word a prefix (`gra:* & hop:*`), over a tsvector of the row's text, 'simple' configuration, accents removed;
//   full text     the same tsvector, ranked by ts_rank_cd;
//   typos         pg_trgm similarity (the % operator, threshold 0.3) between the query and the name.
// Text is compared through search_norm() (lower case, no accents) and search_vec() (the tsvector), the same functions the indexes are built with.

type Db = Pick<PrismaClient, '$queryRaw'>

const sql = Prisma.sql

const pgArray = (values: readonly string[]) => Prisma.sql`${[...values]}::text[]`

/** "Ranks after the cursor": the keyset condition for one type, over a rounded score and the row id. */
function after(query: SearchQuery, type: SearchType, score: Prisma.Sql, id: Prisma.Sql): Prisma.Sql {
  const cursor = query.after
  if (!cursor) return sql`TRUE`
  const typeComes = TYPE_ORDER[type] > TYPE_ORDER[cursor.type]
  const sameType = type === cursor.type
  // The score goes in as text: a JS number is bound as a double, and 0.563 as a double is 0.5629999999999999 once it is a numeric, which is not the 0.5630 the query rounds to.
  const at = cursor.score.toFixed(4)
  // lower score; or the same score and then a later type; or the same type and a later id.
  return sql`(${score} < ${at}::numeric OR (${score} = ${at}::numeric AND (${typeComes} OR (${sameType} AND ${id} COLLATE "C" > ${cursor.id}))))`
}

/** Score text matches: a full-text match is 0.45 to 0.85, a name that starts with the query 0.9, a near name up to 0.85. */
function textScore(vec: Prisma.Sql, ts: Prisma.Sql, name: Prisma.Sql, q: string, like: string): Prisma.Sql {
  return sql`GREATEST(
    CASE WHEN ${vec} @@ ${ts} THEN 0.45 + 0.4 * LEAST(ts_rank_cd(${vec}, ${ts}, 32), 1) ELSE 0 END,
    CASE WHEN ${name} LIKE ${like} THEN 0.9 ELSE 0 END,
    similarity(${name}, ${q}) * 0.85
  )`
}

const rounded = (raw: Prisma.Sql) => sql`ROUND((${raw})::numeric, 4)`

interface Parts {
  q: string
  words: string[]
  tsq: string
  like: string
}

function partsOf(query: SearchQuery): Parts {
  return { q: query.text, words: query.words, tsq: prefixTsQuery(query.words), like: likePrefix(query.text) }
}

// --- People ---------------------------------------------------------------------------------------------------------------

async function users(db: Db, query: SearchQuery, scope: SearchScope): Promise<RankedHit[]> {
  const { q, words, tsq, like } = partsOf(query)
  // A passport field the person set to something other than PUBLIC is neither searched nor returned: the masked columns below are the only ones used after the candidates.
  const visible = (field: string, column: string) => sql`CASE WHEN COALESCE(p."fieldVisibility"->>${field}, 'PUBLIC') = 'PUBLIC' THEN u.${Prisma.raw(`"${column}"`)} END`
  const vec = sql`search_vec(u."name", u."username", ${visible('headline', 'headline')}, ${visible('builderRole', 'builderRole')})`
  const ts = sql`to_tsquery('simple', ${tsq})`
  const skillMatch = sql`EXISTS (
    SELECT 1 FROM "UserSkill" us JOIN "Skill" s ON s."id" = us."skillId"
    WHERE us."userId" = u."id" AND (search_norm(s."name") = ANY(${pgArray(words)}) OR search_norm(s."name") LIKE ${like})
  )`
  const raw = sql`GREATEST(
      CASE WHEN search_norm(u."username") = ${q} THEN 1.0 WHEN search_norm(u."username") LIKE ${like} THEN 0.92 ELSE 0 END,
      CASE WHEN ${vec} @@ ${ts} THEN 0.45 + 0.4 * LEAST(ts_rank_cd(${vec}, ${ts}, 32), 1) ELSE 0 END,
      similarity(search_norm(u."username"), ${q}) * 0.85,
      similarity(search_norm(COALESCE(u."name", '')), ${q}) * 0.8,
      CASE WHEN ${skillMatch} THEN 0.5 ELSE 0 END
    ) + LEAST(u."xp", 5000) / 5000.0 * 0.05`
  const matches = sql`(${vec} @@ ${ts} OR search_norm(u."username") LIKE ${like} OR search_norm(u."username") % ${q} OR search_norm(COALESCE(u."name", '')) % ${q} OR ${skillMatch})`

  const rows = await db.$queryRaw<{ id: string; username: string; name: string | null; image: string | null; headline: string | null; score: number }[]>(sql`
    WITH candidates AS (
      SELECT "id" FROM "User" WHERE search_vec("name", "username", "headline", "builderRole") @@ ${ts}
      UNION SELECT "id" FROM "User" WHERE search_norm("username") LIKE ${like}
      UNION SELECT "id" FROM "User" WHERE search_norm("username") % ${q}
      UNION SELECT "id" FROM "User" WHERE search_norm("name") % ${q}
      UNION SELECT us."userId" FROM "UserSkill" us JOIN "Skill" s ON s."id" = us."skillId" WHERE search_norm(s."name") = ANY(${pgArray(words)}) OR search_norm(s."name") LIKE ${like}
    ), scored AS (
      SELECT u."id", u."username", u."name", u."image", ${visible('headline', 'headline')} AS "headline", ${rounded(raw)} AS "score"
      FROM candidates c
      JOIN "User" u ON u."id" = c."id"
      LEFT JOIN "Profile" p ON p."userId" = u."id"
      WHERE u."deletedAt" IS NULL AND u."birthDateRefusedAt" IS NULL
        AND u."id" <> ${scope.viewerId} AND NOT (u."id" = ANY(${pgArray(scope.hiddenUserIds)}))
        AND COALESCE(p."invisibleMode", false) = false
        AND ${notRestricted('u', scope.now)}
        AND (${notHighRisk('u')} OR search_norm(u."username") = ${q})
        AND ${matches}
    )
    SELECT "id", "username", "name", "image", "headline", "score"::float8 AS "score" FROM scored
    WHERE ${after(query, 'users', sql`"score"`, sql`"id"`)}
    ORDER BY "score" DESC, "id" COLLATE "C" ASC LIMIT ${query.limit}
  `)
  return rows.map((row) => ({ score: Number(row.score), hit: { type: 'user', id: row.id, username: row.username, name: row.name, headline: row.headline, image: row.image } satisfies UserHit }))
}

// --- Projects -------------------------------------------------------------------------------------------------------------

async function projects(db: Db, query: SearchQuery, scope: SearchScope): Promise<RankedHit[]> {
  const { q, tsq, like } = partsOf(query)
  const vec = sql`search_vec(pr."name", pr."shortDesc", search_join(pr."techStack"), left(pr."description", 2000))`
  const ts = sql`to_tsquery('simple', ${tsq})`
  const raw = textScore(vec, ts, sql`search_norm(pr."name")`, q, like)
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; summary: string | null; status: string; isPublic: boolean; score: number }[]>(sql`
    SELECT * FROM (
      SELECT pr."id", pr."slug", pr."name", pr."shortDesc" AS "summary", pr."status"::text AS "status", pr."isPublic", ${rounded(raw)}::float8 AS "score"
      FROM "Project" pr JOIN "User" o ON o."id" = pr."ownerId"
      WHERE (${vec} @@ ${ts} OR search_norm(pr."name") % ${q} OR search_norm(pr."name") LIKE ${like})
        AND o."deletedAt" IS NULL AND NOT (pr."ownerId" = ANY(${pgArray(scope.hiddenUserIds)}))
        AND (pr."isPublic" OR pr."ownerId" = ${scope.viewerId} OR pr."id" = ANY(${pgArray(scope.projectIds)}))
        AND ${notRestricted('o', scope.now)} AND (${notHighRisk('o')} OR pr."ownerId" = ${scope.viewerId})
    ) found
    WHERE ${after(query, 'projects', sql`"score"::numeric`, sql`"id"`)}
    ORDER BY "score" DESC, "id" COLLATE "C" ASC LIMIT ${query.limit}
  `)
  return rows.map((row) => ({ score: Number(row.score), hit: { type: 'project', id: row.id, slug: row.slug, name: row.name, summary: row.summary, status: row.status, isPublic: row.isPublic } satisfies ProjectHit }))
}

// --- Crews ----------------------------------------------------------------------------------------------------------------

async function crews(db: Db, query: SearchQuery, scope: SearchScope): Promise<RankedHit[]> {
  const { q, tsq, like } = partsOf(query)
  const vec = sql`search_vec(t."name", left(t."description", 2000), search_join(t."lookingFor"))`
  const ts = sql`to_tsquery('simple', ${tsq})`
  const raw = textScore(vec, ts, sql`search_norm(t."name")`, q, like)
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; summary: string | null; isRecruiting: boolean; memberCount: number; score: number }[]>(sql`
    SELECT * FROM (
      SELECT t."id", t."slug", t."name", t."description" AS "summary", t."isRecruiting",
        (SELECT COUNT(*)::int FROM "TeamMember" tm WHERE tm."teamId" = t."id") AS "memberCount", ${rounded(raw)}::float8 AS "score"
      FROM "Team" t JOIN "User" o ON o."id" = t."ownerId"
      WHERE (${vec} @@ ${ts} OR search_norm(t."name") % ${q} OR search_norm(t."name") LIKE ${like})
        AND o."deletedAt" IS NULL AND NOT (t."ownerId" = ANY(${pgArray(scope.hiddenUserIds)}))
        AND ${notRestricted('o', scope.now)} AND (${notHighRisk('o')} OR t."ownerId" = ${scope.viewerId})
    ) found
    WHERE ${after(query, 'crews', sql`"score"::numeric`, sql`"id"`)}
    ORDER BY "score" DESC, "id" COLLATE "C" ASC LIMIT ${query.limit}
  `)
  return rows.map((row) => ({
    score: Number(row.score),
    hit: { type: 'crew', id: row.id, slug: row.slug, name: row.name, summary: row.summary ? row.summary.slice(0, 200) : null, isRecruiting: row.isRecruiting, memberCount: Number(row.memberCount) } satisfies CrewHit,
  }))
}

// --- Hackathons -----------------------------------------------------------------------------------------------------------

async function hackathons(db: Db, query: SearchQuery, _scope: SearchScope): Promise<RankedHit[]> {
  const { q, tsq, like } = partsOf(query)
  const vec = sql`search_vec(h."name", h."shortDesc", h."organizer", h."city", h."country", search_join(h."technologies"))`
  const ts = sql`to_tsquery('simple', ${tsq})`
  // A hackathon that has not ended is worth a little more than one that has.
  const raw = sql`${textScore(vec, ts, sql`search_norm(h."name")`, q, like)} + CASE WHEN h."status" IN ('UPCOMING', 'ACTIVE') THEN 0.05 ELSE 0 END`
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; summary: string | null; status: string; startsAt: Date; verified: boolean; score: number }[]>(sql`
    SELECT * FROM (
      SELECT h."id", h."slug", h."name", h."shortDesc" AS "summary", h."status"::text AS "status", h."startDate" AS "startsAt",
        (h."source" = 'NATIVE' OR h."verifiedAt" IS NOT NULL) AS "verified", ${rounded(raw)}::float8 AS "score"
      FROM "Hackathon" h
      WHERE (${vec} @@ ${ts} OR search_norm(h."name") % ${q} OR search_norm(h."name") LIKE ${like})
        AND h."isPublic" = true AND h."moderatedAt" IS NULL
    ) found
    WHERE ${after(query, 'hackathons', sql`"score"::numeric`, sql`"id"`)}
    ORDER BY "score" DESC, "id" COLLATE "C" ASC LIMIT ${query.limit}
  `)
  return rows.map((row) => ({
    score: Number(row.score),
    hit: { type: 'hackathon', id: row.id, slug: row.slug, name: row.name, summary: row.summary, status: row.status, startsAt: new Date(row.startsAt).toISOString(), verified: row.verified } satisfies HackathonHit,
  }))
}

// --- Posts ----------------------------------------------------------------------------------------------------------------

async function posts(db: Db, query: SearchQuery, scope: SearchScope): Promise<RankedHit[]> {
  const { q, tsq, like } = partsOf(query)
  const vec = sql`search_vec(sp."title", left(sp."body", 4000), search_join(sp."stackTags"))`
  const ts = sql`to_tsquery('simple', ${tsq})`
  // A little for being recent (half-life 30 days) and for the respect it got, so of two equal matches the fresher, better-received post comes first.
  const raw = sql`${textScore(vec, ts, sql`search_norm(sp."title")`, q, like)}
    + 0.08 * exp(-GREATEST(EXTRACT(EPOCH FROM (${scope.now}::timestamptz - sp."createdAt" AT TIME ZONE 'UTC')), 0) / (30 * 86400.0) * ln(2))
    + 0.04 * LEAST(sp."propsScore", 10) / 10.0`
  const rows = await db.$queryRaw<{ id: string; title: string; excerpt: string; kind: string; createdAt: Date; authorId: string; username: string; authorName: string | null; score: number }[]>(sql`
    SELECT * FROM (
      SELECT sp."id", sp."title", left(sp."body", 200) AS "excerpt", sp."kind"::text AS "kind", sp."createdAt",
        u."id" AS "authorId", u."username", u."name" AS "authorName", ${rounded(raw)}::float8 AS "score"
      FROM "ShipPost" sp JOIN "User" u ON u."id" = sp."authorId"
      WHERE (${vec} @@ ${ts} OR search_norm(sp."title") % ${q} OR search_norm(sp."title") LIKE ${like})
        AND sp."deletedAt" IS NULL AND sp."moderatedAt" IS NULL
        AND u."deletedAt" IS NULL AND ${notRestricted('u', scope.now)}
        AND (
          sp."authorId" = ${scope.viewerId} OR ${scope.viewerId} = ANY(sp."coAuthorIds")
          OR (
            NOT (sp."authorId" = ANY(${pgArray(scope.hiddenUserIds)})) AND ${notHighRisk('u')}
            AND (
              sp."visibility" = 'PUBLIC'
              OR (sp."visibility" = 'FOLLOWERS' AND sp."authorId" = ANY(${pgArray(scope.followingIds)}))
              OR (sp."visibility" = 'CREW' AND (sp."projectId" = ANY(${pgArray(scope.projectIds)}) OR sp."teamId" = ANY(${pgArray(scope.teamIds)})))
            )
          )
        )
    ) found
    WHERE ${after(query, 'posts', sql`"score"::numeric`, sql`"id"`)}
    ORDER BY "score" DESC, "id" COLLATE "C" ASC LIMIT ${query.limit}
  `)
  return rows.map((row) => ({
    score: Number(row.score),
    hit: {
      type: 'post',
      id: row.id,
      title: row.title,
      excerpt: row.excerpt,
      kind: row.kind,
      createdAt: new Date(row.createdAt).toISOString(),
      author: { id: row.authorId, username: row.username, name: row.authorName },
    } satisfies PostHit,
  }))
}

const BY_TYPE: Record<SearchType, (db: Db, query: SearchQuery, scope: SearchScope) => Promise<RankedHit[]>> = { users, projects, crews, hackathons, posts }

export class PostgresSearch implements SearchProvider {
  readonly kind = 'postgres' as const

  constructor(private readonly db: Db) {}

  async search(query: SearchQuery, scope: SearchScope): Promise<SearchPage> {
    const perType = await Promise.all(query.types.map((type) => BY_TYPE[type](this.db, query, scope)))
    // The same order the queries and the cursor use: score, then type, then id (compared as bytes: the queries order ids in the C collation).
    const merged = perType.flat().sort((a, b) => b.score - a.score || TYPE_ORDER[HIT_TYPE[a.hit.type]] - TYPE_ORDER[HIT_TYPE[b.hit.type]] || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0))
    return { hits: merged.slice(0, query.limit) }
  }
}
