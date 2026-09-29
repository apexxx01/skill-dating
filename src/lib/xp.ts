import type { PrismaClient, Prisma } from '@prisma/client'

// Single source of truth for XP amounts, so the same action always awards
// the same XP no matter which route triggers it, and so amounts can be
// tuned in one place instead of hunting through every API route.
export const XP_AWARDS = {
  PROJECT_CREATED: 50,
  PROJECT_SHIP: 200,
  HACKATHON_JOIN: 100,
  TEAM_FORMED: 50,
  HACKATHON_WIN: 500,
} as const

export type XpAwardType = keyof typeof XP_AWARDS

/**
 * Ship XP/reputation must be awarded exactly once per project, ever — not
 * once per SHIPPED transition. A project's `shippedAt` is only ever set the
 * first time it ships, so its presence is the one-time gate: cycling
 * SHIPPED -> BUILDING -> SHIPPED cannot re-trigger the award.
 */
export function canAwardShipXp(project: { status?: string | null; shippedAt: Date | null }, nextStatus: string | undefined): boolean {
  return nextStatus === 'SHIPPED' && !project.shippedAt
}

type PrismaOrTx = PrismaClient | Prisma.TransactionClient

/**
 * Records an XPEvent AND keeps User.xp in sync in one call. Every XP award
 * must go through this — creating an XPEvent alone (the old pattern at
 * every call site) left User.xp permanently at 0 for every user, since
 * nothing ever aggregated the event log into it. Leaderboard reads should
 * still prefer a live SUM(XPEvent.amount) as the source of truth; User.xp
 * here is a denormalized cache for cheap sort/display elsewhere.
 */
export async function awardXp(
  prisma: PrismaOrTx,
  userId: string,
  type: XpAwardType | 'ACHIEVEMENT_EARNED',
  description: string,
  // Achievements don't share one fixed amount the way XP_AWARDS entries do
  // (each achievement defines its own xpReward), so 'ACHIEVEMENT_EARNED'
  // takes its amount here instead of from the fixed-amount table.
  explicitAmount?: number
): Promise<void> {
  const amount = type === 'ACHIEVEMENT_EARNED' ? (explicitAmount ?? 0) : XP_AWARDS[type]
  await prisma.xPEvent.create({ data: { userId, type, amount, description } })
  await prisma.user.update({ where: { id: userId }, data: { xp: { increment: amount } } })
}
