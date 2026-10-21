import type { Prisma, PrismaClient } from '@prisma/client'
import { isHighRisk } from './risk-job'
import { reachOf, type Reach } from './reach'

type Db = PrismaClient | Prisma.TransactionClient

/** A person's reach (reach.ts) from their account and their risk level. An unknown account has the least reach. */
export async function reachFor(db: Db, userId: string, now: Date = new Date()): Promise<Reach> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isEmailVerified: true, createdAt: true, verificationLevel: true } })
  if (!user) return reachOf({ isEmailVerified: false, createdAt: now, verificationLevel: 'NONE' }, { now })
  return reachOf(user, { now, highRisk: await isHighRisk(db as PrismaClient, userId) })
}
