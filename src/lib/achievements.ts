import { ACHIEVEMENT_DEFINITIONS, type AchievementDefinition, type AchievementSlug } from './achievement-definitions'
import { afterCommit, recordReward, type Db } from './events'
import { track } from './infra/analytics'
import { recordActivity } from './activity'
import { grant } from './rewards'
import { emptyEnvelope, type EnvelopeDraft } from './rewards-envelope'

/**
 * Grants an achievement to a user, idempotently. Always call this from
 * inside the same transaction as the action that earned it (normally through
 * the rewards subscriber, see subscribers.ts). The Achievement row is upserted
 * by slug from the shared definitions file, so granting an achievement that's
 * never been granted before still works without a separate seed step - but
 * `update: {}` on the upsert means an admin-edited name/description/xpReward
 * isn't silently overwritten on every subsequent grant.
 *
 * Safe to call more than once for the same user+slug: the second call is a
 * no-op (no duplicate UserAchievement row, no double XP, no duplicate
 * activity entry or notification), enforced by the UserAchievement unique
 * constraint, which is what decides whether this call created the row (safe
 * under concurrency). The achievement's XP goes through the rewards engine
 * like any other award.
 */
export async function grantAchievement(
  tx: Db,
  userId: string,
  slug: AchievementSlug,
  /** Where the counter stood, stored with the unlock. Defaults to the target met exactly. */
  progress?: { current: number; target: number }
): Promise<{ granted: boolean; envelope?: EnvelopeDraft }> {
  const def: AchievementDefinition = ACHIEVEMENT_DEFINITIONS[slug]
  const target = def.criteria.target

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
    data: [{ userId, achievementId: achievement.id, progress: progress ?? { current: target, target } }],
    skipDuplicates: true,
  })
  if (inserted.count === 0) {
    return { granted: false }
  }

  let totalXp: number
  if (achievement.xpReward > 0) {
    const result = await grant(tx, userId, 'ACHIEVEMENT_EARNED', {
      sourceType: 'ACHIEVEMENT',
      sourceId: slug,
      amount: achievement.xpReward,
      description: `Earned achievement "${achievement.name}"`,
    })
    totalXp = result.envelope.totalXp
  } else {
    totalXp = (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { xp: true } })).xp
  }

  await recordActivity(tx, userId, 'ACHIEVEMENT_EARNED', `Earned "${achievement.name}"`, {
    description: achievement.description,
    metadata: { achievementId: achievement.id, slug }
  })

  await tx.notification.create({
    data: {
      userId,
      type: 'ACHIEVEMENT',
      title: 'Achievement unlocked',
      message: achievement.name,
      metadata: { kind: 'ACHIEVEMENT_UNLOCKED', slug },
    },
  })

  // The XP part was recorded by grant(); this adds the unlock itself to what the request reports.
  const envelope: EnvelopeDraft = { ...emptyEnvelope(totalXp), achievements: [{ slug, name: achievement.name }] }
  recordReward(tx, userId, envelope)
  afterCommit(tx, () => track(userId, 'achievement_earned', { slug, xpReward: achievement.xpReward }))

  return { granted: true, envelope }
}
