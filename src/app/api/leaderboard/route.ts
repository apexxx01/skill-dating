import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam, decodeOffsetCursor, encodeOffsetCursor } from '@/lib/api/pagination'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { blockedUserIds } from '@/lib/blocks'
import { liveRank } from '@/lib/leaderboard'

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  cursor: cursorParam,
})

// Computed live from XPEvent (SUM per user), not read from the denormalized
// User.xp cache. User.xp is kept in sync by the rewards engine (lib/rewards.ts) for cheap
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
  // Ranks are positions, so the cursor is a position too (an offset cursor).
  const cursor = queryResult.data.cursor
  const skip = cursor === undefined ? (page - 1) * limit : decodeOffsetCursor(cursor)
  if (skip === null) return createApiError('INVALID_CURSOR')

  // Users blocked in either direction are left out, and ranks are counted
  // among the users this viewer can actually see.
  const hidden = await blockedUserIds(prisma, user.id)
  const hiddenFilter = hidden.length ? Prisma.sql`WHERE "userId" NOT IN (${Prisma.join(hidden)})` : Prisma.empty

  const [totalRow, grouped] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(DISTINCT "userId") as count FROM "XPEvent" ${hiddenFilter}`,
    prisma.xPEvent.groupBy({
      by: ['userId'],
      where: hidden.length ? { userId: { notIn: hidden } } : undefined,
      _sum: { amount: true },
      // userId breaks ties, so people with equal XP keep one order from page to page.
      orderBy: [{ _sum: { amount: 'desc' } }, { userId: 'asc' }],
      skip,
      take: limit + 1,
    }),
  ])

  const total = Number(totalRow[0]?.count ?? 0)
  const hasMore = grouped.length > limit
  if (hasMore) grouped.pop()
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

  // The caller's own standing, even off the current page.
  const { xp: myXp, rank: myRank } = await liveRank(prisma, user.id, hidden)

  return createApiResponse({
    entries,
    me: { xp: myXp, rank: myRank },
    nextCursor: hasMore ? encodeOffsetCursor(skip + limit) : null,
    ...(cursor === undefined ? { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } : {}),
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'leaderboard:get' } })
