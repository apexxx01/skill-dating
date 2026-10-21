import { Prisma } from '@prisma/client'
import { utcTimestamp } from '@/lib/sql'

// The reach rules as SQL, for the queries that build pools of people (drops, the romance drop, the squad builder, the feed). One place, so every pool
// leaves out the same people:
//   - a HIGH risk level (an admin's override wins over the computed one): reduced reach, never shown to strangers;
//   - an active suspension or ban; for a feature's own pool, a restriction of that feature;
//   - for a viewer, the people they muted.

/** The person (`alias`."id") does not have an effective HIGH risk level. */
export function notHighRisk(alias: string): Prisma.Sql {
  const id = Prisma.raw(`${alias}."id"`)
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM "UserRisk" ur WHERE ur."userId" = ${id} AND COALESCE(ur."overrideLevel", ur."level") = 'HIGH')`
}

/** The person has no restriction of these kinds in force at `now` (suspensions and bans are always included). */
export function notRestricted(alias: string, now: Date, kinds: readonly ('ROMANCE' | 'MESSAGING' | 'POSTING')[] = []): Prisma.Sql {
  const id = Prisma.raw(`${alias}."id"`)
  const all = ['SUSPENDED', 'BANNED', ...kinds]
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "UserRestriction" rs WHERE rs."userId" = ${id} AND rs."liftedAt" IS NULL
      AND (rs."endsAt" IS NULL OR rs."endsAt" > ${utcTimestamp(now)}) AND rs."kind"::text = ANY(${all}::text[])
  )`
}

/** The viewer has not muted the person. */
export function notMutedBy(alias: string, viewerId: string): Prisma.Sql {
  const id = Prisma.raw(`${alias}."id"`)
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM "Mute" mu WHERE mu."muterId" = ${viewerId} AND mu."mutedId" = ${id})`
}
