import type { PrismaClient } from '@prisma/client'
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_SLUGS } from '@/lib/achievement-definitions'

// Rarity: the share of recently active users who have an achievement, 0 to 1. "Recently active"
// means they were seen in the last 30 days, so the number does not shrink because the user base
// is full of people who left, and a brand-new achievement is rare (not "0 of nobody"). Only
// active people count on both sides, so the share can never pass 1. Recomputed nightly
// (achievements/rarity in src/lib/infra/jobs.ts) in a single statement.

export const RARITY_WINDOW_DAYS = 30

export interface RarityResult {
  achievements: number
  activeUsers: number
}

export async function recomputeRarity(prisma: PrismaClient, now: Date = new Date()): Promise<RarityResult> {
  // Every definition has a row, so an achievement nobody has earned yet is rarity 0 rather than missing.
  for (const slug of ACHIEVEMENT_SLUGS) {
    await prisma.achievement.upsert({ where: { slug }, create: { slug, ...ACHIEVEMENT_DEFINITIONS[slug] }, update: {} })
  }

  const since = new Date(now.getTime() - RARITY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const [{ active }] = await prisma.$queryRaw<{ active: bigint }[]>`
    SELECT COUNT(*) AS "active" FROM "User" WHERE "lastActiveAt" >= ${since} AND "deletedAt" IS NULL
  `
  const activeUsers = Number(active)

  const updated = await prisma.$executeRaw`
    UPDATE "Achievement" a
    SET "rarity" = CASE
          WHEN ${activeUsers} = 0 THEN NULL
          ELSE LEAST(1.0, (
            SELECT COUNT(*) FROM "UserAchievement" ua
            JOIN "User" u ON u."id" = ua."userId" AND u."lastActiveAt" >= ${since} AND u."deletedAt" IS NULL
            WHERE ua."achievementId" = a."id"
          )::float / ${activeUsers})
        END,
        "rarityUpdatedAt" = ${now}
  `
  return { achievements: updated, activeUsers }
}

/** What the nightly job runs. */
export async function runRarityJob(): Promise<RarityResult> {
  const { prisma } = await import('@/lib/prisma')
  return recomputeRarity(prisma)
}
