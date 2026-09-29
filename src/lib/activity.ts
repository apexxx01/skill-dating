import type { PrismaClient, Prisma } from '@prisma/client'

type PrismaOrTx = PrismaClient | Prisma.TransactionClient

/**
 * Appends one row to the public activity feed. Always call this in the same
 * transaction as the state change it describes, so the feed can never show
 * an activity for something that didn't actually commit (or vice versa).
 */
export async function recordActivity(
  tx: PrismaOrTx,
  userId: string,
  type: string,
  title: string,
  options: { description?: string; link?: string; metadata?: Record<string, unknown>; projectId?: string } = {}
) {
  return tx.activity.create({
    data: {
      userId,
      type,
      title,
      description: options.description,
      link: options.link,
      metadata: options.metadata as Prisma.InputJsonValue | undefined,
      projectId: options.projectId,
    }
  })
}
