import type { PrismaClient, Prisma } from '@prisma/client'
import { ACHIEVEMENT_DEFINITIONS, type AchievementSlug } from './achievement-definitions'
import { awardXp } from './xp'
import { recordActivity } from './activity'

type PrismaOrTx = PrismaClient | Prisma.TransactionClient

/**
 * Grants an achievement to a user, idempotently. Always call this from
 * inside the same transaction as the action that earned it. The
 * Achievement row is upserted by slug from the shared definitions file, so
 * granting an achievement that's never been granted before still works
 * without a separate seed step - but `update: {}` on the upsert means an
 * admin-edited name/description/xpReward isn't silently overwritten on
 * every subsequent grant.
 *
 * Safe to call more than once for the same user+slug: the second call is a
 * no-op (no duplicate UserAchievement row, no double XP, no duplicate
 * activity entry), enforced by the UserAchievement unique constraint, which
 * is what decides whether this call created the row (safe under concurrency).
 */
export async function grantAchievement(
  tx: PrismaOrTx,
  userId: string,
  slug: AchievementSlug
): Promise<{ granted: boolean }> {
  const def = ACHIEVEMENT_DEFINITIONS[slug]

  const achievement = await tx.achievement.upsert({
    where: { slug },
    create: { slug, ...def },
    update: {}
  })

  // The unique (userId, achievementId) constraint is the arbiter: INSERT ..
  // ON CONFLICT DO NOTHING reports whether THIS call created the row. A
  // check-then-insert would let two concurrent transactions both pass the
  // check, after which one fails on the constraint and aborts its whole
  // enclosing transaction (the project, update or milestone it belongs to).
  const inserted = await tx.userAchievement.createMany({
    data: [{ userId, achievementId: achievement.id }],
    skipDuplicates: true,
  })
  if (inserted.count === 0) {
    return { granted: false }
  }

  if (achievement.xpReward > 0) {
    await awardXp(tx, userId, 'ACHIEVEMENT_EARNED', `Earned achievement "${achievement.name}"`, achievement.xpReward)
  }

  await recordActivity(tx, userId, 'ACHIEVEMENT_EARNED', `Earned "${achievement.name}"`, {
    description: achievement.description,
    metadata: { achievementId: achievement.id, slug }
  })

  return { granted: true }
}
