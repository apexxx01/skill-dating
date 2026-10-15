import type { RewardsEnvelope } from '@/types/api'
import { afterCommit, recordReward, type Db } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { advisoryLock } from '@/lib/progress'
import { dedupeKeyFor, REWARD_RULES, type RewardAction, type RewardSource } from '@/lib/rewards-config'
import { emptyEnvelope, envelopeForGain } from '@/lib/rewards-envelope'
import { localDayStart } from '@/lib/time'

// The rewards engine: the ONLY code that writes an XPEvent or changes User.xp.
// Routes do not call it; they emit a domain event inside their transaction and
// the subscriber in src/lib/subscribers.ts calls grant() (rules in rewards-config.ts).
//
// Guarantees:
//  - once per source: the unique index on XPEvent (userId, type, dedupeKey) makes
//    "the same award" impossible to pay twice, whatever retries or races happen;
//  - daily caps count awards since the user's LOCAL midnight (User.timezone, UTC
//    when unset) and are serialised per user and action, so parallel requests
//    cannot both slip under the cap;
//  - it runs on the caller's transaction, so XP commits or rolls back with the
//    action that earned it;
//  - User.xp is a cache of the XPEvent total and changes only here.

export interface GrantOptions extends RewardSource {
  /** Shown in the XP history. */
  description: string
  /** Only for actions whose rule has no fixed amount (achievements). Ignored otherwise. */
  amount?: number
  /** The clock, for tests. */
  now?: Date
}

export type GrantResult =
  | { granted: true; xp: number; envelope: RewardsEnvelope }
  | { granted: false; reason: 'DUPLICATE' | 'DAILY_CAP' | 'NO_REWARD'; envelope: RewardsEnvelope }

export async function grant(tx: Db, userId: string, action: RewardAction, options: GrantOptions): Promise<GrantResult> {
  const rule = REWARD_RULES[action]
  if (options.sourceType !== rule.sourceType) {
    throw new Error(`${action} is earned for a ${rule.sourceType}, not a ${options.sourceType}`)
  }

  const user = await tx.user.findUnique({ where: { id: userId }, select: { xp: true, timezone: true } })
  if (!user) throw new Error(`cannot reward unknown user ${userId}`)

  const amount = rule.amount ?? options.amount ?? 0
  const declined = (reason: 'DUPLICATE' | 'DAILY_CAP' | 'NO_REWARD'): GrantResult => ({
    granted: false,
    reason,
    envelope: emptyEnvelope(user.xp),
  })
  if (!Number.isInteger(amount) || amount <= 0) return declined('NO_REWARD')

  const dedupeKey = dedupeKeyFor(options)
  const already = await tx.xPEvent.findUnique({
    where: { userId_type_dedupeKey: { userId, type: action, dedupeKey } },
    select: { id: true },
  })
  if (already) return declined('DUPLICATE')

  if (rule.dailyCap !== null) {
    // Parallel requests for one user and action line up here, so the count below is current.
    await advisoryLock(tx as Parameters<typeof advisoryLock>[0], `xp-cap:${userId}:${action}`)
    const since = localDayStart(options.now ?? new Date(), user.timezone)
    const today = await tx.xPEvent.count({ where: { userId, type: action, createdAt: { gte: since } } })
    if (today >= rule.dailyCap) return declined('DAILY_CAP')
  }

  // ON CONFLICT DO NOTHING: when two requests race past the check above, the unique
  // index lets exactly one insert, and the other sees count 0 once the first commits.
  const inserted = await tx.xPEvent.createMany({
    data: [
      {
        userId,
        type: action,
        amount,
        description: options.description,
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        dedupeKey,
      },
    ],
    skipDuplicates: true,
  })
  if (inserted.count === 0) return declined('DUPLICATE')

  // One atomic increment, so concurrent awards to one user cannot lose an update.
  const [row] = await (tx as Parameters<typeof advisoryLock>[0]).$queryRaw<{ xp: number }[]>`
    UPDATE "User" SET "xp" = "xp" + ${amount} WHERE "id" = ${userId} RETURNING "xp"
  `
  const envelope = envelopeForGain(row.xp - amount, amount)

  if (envelope.leveledUp) {
    await tx.notification.create({
      data: {
        userId,
        type: 'ACHIEVEMENT',
        title: 'Level up!',
        message: `You reached level ${envelope.newLevel}`,
        metadata: { kind: 'LEVEL_UP', level: envelope.newLevel, tier: envelope.newTier },
      },
    })
    afterCommit(tx, () => track(userId, 'level_up', { level: envelope.newLevel, tier: envelope.newTier }))
  }
  if (envelope.tierChanged) {
    await tx.notification.create({
      data: {
        userId,
        type: 'ACHIEVEMENT',
        title: 'New tier!',
        message: `You are now ${envelope.newTier}`,
        metadata: { kind: 'TIER_UP', tier: envelope.newTier, level: envelope.newLevel },
      },
    })
    afterCommit(tx, () => track(userId, 'tier_up', { tier: envelope.newTier, level: envelope.newLevel }))
  }

  recordReward(tx, userId, envelope)
  return { granted: true, xp: amount, envelope }
}
