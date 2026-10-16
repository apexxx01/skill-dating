import type { RewardsEnvelope } from '@/types/api'
import { afterCommit, emit, recordReward, type Db } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { advisoryLock } from '@/lib/progress'
import { dedupeKeyFor, REWARD_RULES, type RewardAction, type RewardSource } from '@/lib/rewards-config'
import { emptyEnvelope, envelopeForGain, type EnvelopeDraft } from '@/lib/rewards-envelope'
import { readUserStreak, steadyStatus } from '@/lib/streak-status'
import { advanceStreak, COMEBACK_IDLE_DAYS, columnsFromStreak, effectiveStreak, streakDay, streakFromColumns } from '@/lib/streaks'
import { localDayStart } from '@/lib/time'
import { onXpEarned } from '@/lib/xp-views'

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
//  - User.xp is a cache of the XPEvent total and changes only here;
//  - the user's streak moves here too, in the same transaction, when the award is an action of
//    their own (see streaks.ts), and every award is stamped with the season it was earned in.

export interface GrantOptions extends RewardSource {
  /** Shown in the XP history. */
  description: string
  /** Only for actions whose rule has no fixed amount (achievements). Ignored otherwise. */
  amount?: number
  /** The clock, for tests. */
  now?: Date
  /**
   * False when the user is on the receiving end of this award rather than the one who acted (the
   * person whose connection request was accepted). Their award is still paid; it just does not
   * count as an action of their own for the streak. Default true.
   */
  actor?: boolean
}

export type GrantResult =
  | { granted: true; xp: number; envelope: EnvelopeDraft }
  | { granted: false; reason: 'DUPLICATE' | 'DAILY_CAP' | 'NO_REWARD'; envelope: EnvelopeDraft }

/** The "nothing earned" envelope for a user, for responses of requests that may award but did not. */
export async function currentRewards(db: Db, userId: string): Promise<RewardsEnvelope> {
  const read = await readUserStreak(db, userId)
  return { ...emptyEnvelope(read?.xp ?? 0), streak: read ? steadyStatus(read) : { current: 0, longest: 0, extended: false, freezeUsed: false } }
}

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

  // The season being played, so season boards can add XP up from the log.
  const season = await tx.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' }, select: { id: true } })

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
        seasonId: season?.id ?? null,
      },
    ],
    skipDuplicates: true,
  })
  if (inserted.count === 0) return declined('DUPLICATE')

  // One atomic increment, so concurrent awards to one user cannot lose an update. It also takes the
  // user's row lock, so the streak columns it returns are the committed ones and nobody else changes
  // them until this transaction ends.
  const [row] = await (tx as Parameters<typeof advisoryLock>[0]).$queryRaw<
    { xp: number; currentStreak: number; longestStreak: number; lastStreakDay: string | null; streakFreezes: number; streakFreezeUsed: boolean }[]
  >`
    UPDATE "User" SET "xp" = "xp" + ${amount} WHERE "id" = ${userId}
    RETURNING "xp", "currentStreak", "longestStreak", "lastStreakDay", "streakFreezes", "streakFreezeUsed"
  `
  const now = options.now ?? new Date()
  const today = streakDay(now, user.timezone)
  const stored = streakFromColumns(row)

  // Only an action of the user's own moves the streak. Anything else reports where it stands.
  const step = rule.streak && options.actor !== false ? advanceStreak(stored, today) : null
  if (step && !step.alreadyCounted) {
    await tx.user.update({ where: { id: userId }, data: columnsFromStreak(step.state) })
  }
  const streak = step && !step.alreadyCounted
    ? { current: step.state.current, longest: step.state.longest, extended: step.extended, freezeUsed: step.freezeUsed }
    : { current: effectiveStreak(stored, today), longest: stored.longest, extended: false, freezeUsed: false }

  const envelope = envelopeForGain(row.xp - amount, amount, [], streak)

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

  afterCommit(tx, () => onXpEarned({ userId, amount, at: now, seasonId: season?.id ?? null }))
  recordReward(tx, userId, envelope)

  // Announced after the award is recorded, so whatever the streak unlocks is merged in after it.
  if (step && !step.alreadyCounted) {
    if (step.extended) {
      afterCommit(tx, () => track(userId, 'streak_extended', { current: step.state.current }))
      await emit(tx, 'STREAK_EXTENDED', {
        userId,
        current: step.state.current,
        longest: step.state.longest,
        freezeUsedInRun: step.state.freezeUsedInRun,
      })
    }
    if (stored.lastDay !== null && step.idleDays >= COMEBACK_IDLE_DAYS) {
      await emit(tx, 'USER_COMEBACK', { userId, idleDays: step.idleDays })
    }
  }

  return { granted: true, xp: amount, envelope }
}
