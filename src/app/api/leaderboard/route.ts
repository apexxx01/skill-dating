import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { z } from 'zod'

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
})

// Computed live from XPEvent (SUM per user), not read from the denormalized
// User.xp cache. User.xp is kept in sync by lib/xp.ts's awardXp() for cheap
// display/sort elsewhere, but the leaderboard is the one place score
// actually matters, so it earns the real aggregate query instead of trusting
// a field that (before this change) silently sat at 0 for every user.
//
// Scope note: the schema also has Leaderboard/LeaderboardEntry tables for
// precomputed snapshots (GLOBAL/HACKATHON/TECHNICAL/SHIPPING/RISING/
// CHALLENGE x ALL_TIME/MONTHLY/WEEKLY/DAILY). Populating those needs a
// refresh cadence and a decision on which types/periods to support — that's
// a product call, not a bug, so it's flagged rather than guessed at. This
// endpoint covers the unambiguous case: a live, always-correct, all-time
// global leaderboard.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 50
  const skip = (page - 1) * limit

  const [totalRow, grouped] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(DISTINCT "userId") as count FROM "XPEvent"`,
    prisma.xPEvent.groupBy({
      by: ['userId'],
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      skip,
      take: limit,
    }),
  ])

  const total = Number(totalRow[0]?.count ?? 0)
  const userIds = grouped.map(g => g.userId)

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true }
  })
  const userById = new Map(users.map(u => [u.id, u]))

  const entries = grouped
    .map((g, i) => ({
      rank: skip + i + 1,
      xp: g._sum.amount ?? 0,
      user: userById.get(g.userId) ?? null,
    }))
    .filter(e => e.user !== null)

  // The caller's own standing, even off the current page — cheap single
  // aggregate, and knowing "you're #842" is more useful than nothing.
  const myAggregate = await prisma.xPEvent.aggregate({
    where: { userId: user.id },
    _sum: { amount: true },
  })
  const myXp = myAggregate._sum.amount ?? 0
  const myRankRow = await prisma.$queryRaw<{ rank: bigint }[]>`
    SELECT COUNT(*) + 1 as rank
    FROM (
      SELECT "userId", SUM("amount") as total
      FROM "XPEvent"
      GROUP BY "userId"
      HAVING SUM("amount") > ${myXp}
    ) as ahead
  `
  const myRank = myXp > 0 ? Number(myRankRow[0]?.rank ?? 0) : null

  return createApiResponse({
    entries,
    me: { xp: myXp, rank: myRank },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'leaderboard:get' } })
