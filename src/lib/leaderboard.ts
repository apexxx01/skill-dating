import { Prisma, type PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * A user's real standing: their XP from the event log and their rank among
 * everyone with XP (1 = most). The stored User.rank column is never updated,
 * so this is what any "rank" shown to a user must come from. `rank` is null
 * for a user with no XP. Users in `excludeUserIds` are left out of the
 * comparison (used to rank a viewer among the users they can see).
 */
export async function liveRank(
  db: Db,
  userId: string,
  excludeUserIds: string[] = []
): Promise<{ xp: number; rank: number | null }> {
  const aggregate = await db.xPEvent.aggregate({ where: { userId }, _sum: { amount: true } })
  const xp = aggregate._sum.amount ?? 0
  if (xp <= 0) return { xp, rank: null }

  const exclude = excludeUserIds.length
    ? Prisma.sql`WHERE "userId" NOT IN (${Prisma.join(excludeUserIds)})`
    : Prisma.empty
  const rows = await db.$queryRaw<{ rank: bigint }[]>`
    SELECT COUNT(*) + 1 AS rank
    FROM (
      SELECT "userId", SUM("amount") AS total
      FROM "XPEvent"
      ${exclude}
      GROUP BY "userId"
      HAVING SUM("amount") > ${xp}
    ) AS ahead
  `
  return { xp, rank: Number(rows[0]?.rank ?? 0) }
}
