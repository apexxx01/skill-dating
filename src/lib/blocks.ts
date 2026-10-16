import { NextResponse } from 'next/server'
import { errorResponse, type ErrorCode } from '@/lib/api/errors'
import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type BlockRelation = 'BLOCKED_BY_ME' | 'BLOCKED_BY_THEM'

// A Block row is directional (who blocked whom) but enforcement is symmetric:
// while a row exists in either direction the two users cannot message,
// connect with, invite or apply to each other, and each is hidden from the
// other's discovery surfaces.

/**
 * Every user who should be left out of `userId`'s browse and discovery lists: the
 * ones who have blocked them or been blocked by them, plus accounts whose Clerk
 * user was deleted (anonymised tombstones, see tombstoneClerkUser). Every caller
 * is a list or search surface; interactions use blockRelation / blockGuard.
 */
export async function blockedUserIds(db: Db, userId: string): Promise<string[]> {
  const [rows, deleted] = await Promise.all([
    db.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    }),
    db.user.findMany({ where: { deletedAt: { not: null } }, select: { id: true } }),
  ])
  const ids = new Set<string>()
  for (const row of rows) ids.add(row.blockerId === userId ? row.blockedId : row.blockerId)
  for (const row of deleted) ids.add(row.id)
  return [...ids]
}

/**
 * Only the people `userId` has blocked or been blocked by: the same as blockedUserIds without the accounts
 * that were deleted. For lists that already leave deleted accounts out by themselves (the leaderboards
 * drop a deleted member when they show the board), where adding every deleted account ever would make
 * the list grow without bound.
 */
export async function blockedPeerIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  })
  return [...new Set(rows.map((row) => (row.blockerId === userId ? row.blockedId : row.blockerId)))]
}

/**
 * The block relationship between two users from `me`'s point of view, or null.
 * If both directions exist, "blocked by me" wins: the caller's own decision is
 * what they can act on.
 */
export async function blockRelation(db: Db, me: string, other: string): Promise<BlockRelation | null> {
  if (me === other) return null
  const rows = await db.block.findMany({
    where: {
      OR: [
        { blockerId: me, blockedId: other },
        { blockerId: other, blockedId: me },
      ],
    },
    select: { blockerId: true },
  })
  if (rows.length === 0) return null
  return rows.some((r) => r.blockerId === me) ? 'BLOCKED_BY_ME' : 'BLOCKED_BY_THEM'
}

/**
 * Standard refusal for an interaction between `me` and `other`, or null when
 * they may interact. The person who placed the block is told plainly; the
 * person who was blocked gets an ordinary "not found" so being blocked is not
 * revealed to them.
 */
export async function blockGuard(
  db: Db,
  me: string,
  other: string,
  notFound: ErrorCode = 'USER_NOT_FOUND'
): Promise<NextResponse | null> {
  const relation = await blockRelation(db, me, other)
  if (relation === 'BLOCKED_BY_ME') {
    return errorResponse('USER_BLOCKED')
  }
  if (relation === 'BLOCKED_BY_THEM') {
    return errorResponse(notFound)
  }
  return null
}

/** First refusal across several counterparts, or null if none is blocked. */
export async function blockGuardAny(
  db: Db,
  me: string,
  others: string[],
  notFound: ErrorCode = 'USER_NOT_FOUND'
): Promise<NextResponse | null> {
  const unique = [...new Set(others)].filter((id) => id !== me)
  if (unique.length === 0) return null
  const rows = await db.block.findMany({
    where: {
      OR: [
        { blockerId: me, blockedId: { in: unique } },
        { blockedId: me, blockerId: { in: unique } },
      ],
    },
    select: { blockerId: true },
  })
  if (rows.length === 0) return null
  return rows.some((r) => r.blockerId === me)
    ? errorResponse('USER_BLOCKED')
    : errorResponse(notFound)
}
