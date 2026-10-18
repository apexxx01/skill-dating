import { Prisma, type PrismaClient } from '@prisma/client'
import { MIN_TRUSTED_ACCOUNT_AGE_DAYS } from '@/lib/trust'
import { utcTimestamp } from '@/lib/sql'

// "Proof of character": how many different builders have vouched for a person. It is the evidence-endorsement rows (type PEER_ENDORSEMENT, one per
// endorser and piece of evidence, owned by the endorsed person) counted by DISTINCT endorser, and only endorsers the platform trusts count (a
// verified email, an account a week old, not deleted): three fresh accounts cannot open somebody's inbox or lift their score.

type Db = Pick<PrismaClient, '$queryRaw'>

const DAY_MS = 24 * 60 * 60 * 1000

export async function countCharacterEndorsers(db: Db, userIds: readonly string[], now: Date = new Date()): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (userIds.length === 0) return out
  const trustedBefore = utcTimestamp(new Date(now.getTime() - MIN_TRUSTED_ACCOUNT_AGE_DAYS * DAY_MS))
  const rows = await db.$queryRaw<{ userId: string; n: bigint }[]>(Prisma.sql`
    SELECT se."userId", COUNT(DISTINCT e."id") AS "n"
    FROM "SkillEvidence" se
    JOIN "User" e ON e."id" = se."metadata"->>'endorserId'
    WHERE se."userId" = ANY(${[...new Set(userIds)]}::text[])
      AND se."type" = 'PEER_ENDORSEMENT'
      AND e."deletedAt" IS NULL AND e."isEmailVerified" = true AND e."createdAt" <= ${trustedBefore}
      AND e."id" <> se."userId"
    GROUP BY se."userId"
  `)
  for (const row of rows) out.set(row.userId, Number(row.n))
  return out
}
