import { NextResponse } from 'next/server'
import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type BlockRelation = 'BLOCKED_BY_ME' | 'BLOCKED_BY_THEM'

// A Block row is directional (who blocked whom) but enforcement is symmetric:
// while a row exists in either direction the two users cannot message,
// connect with, invite or apply to each other, and each is hidden from the
// other's discovery surfaces.

/** Every user who has blocked `userId` or been blocked by them. */
export async function blockedUserIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  })
  const ids = new Set<string>()
  for (const row of rows) ids.add(row.blockerId === userId ? row.blockedId : row.blockerId)
  return [...ids]
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
  notFoundMessage = 'User not found'
): Promise<NextResponse | null> {
  const relation = await blockRelation(db, me, other)
  if (relation === 'BLOCKED_BY_ME') {
    return NextResponse.json({ error: 'You have blocked this user' }, { status: 403 })
  }
  if (relation === 'BLOCKED_BY_THEM') {
    return NextResponse.json({ error: notFoundMessage }, { status: 404 })
  }
  return null
}

/** First refusal across several counterparts, or null if none is blocked. */
export async function blockGuardAny(
  db: Db,
  me: string,
  others: string[],
  notFoundMessage = 'User not found'
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
    ? NextResponse.json({ error: 'You have blocked this user' }, { status: 403 })
    : NextResponse.json({ error: notFoundMessage }, { status: 404 })
}
