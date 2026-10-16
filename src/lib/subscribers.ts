import { bus, type DomainEventName, type EmitResult, type EventBus, type TransactionalContext } from '@/lib/events'
import { grantAchievement } from '@/lib/achievements'
import { track } from '@/lib/infra/analytics'
import { grant } from '@/lib/rewards'
import { applicantRewardEligible, EVENT_REWARDS } from '@/lib/rewards-config'
import { endorsementRewardAllowed } from '@/lib/skill-evidence'

// Who listens to what. This module is loaded by the bus before the first event
// (see events.ts), so a route only has to emit.

type AnyEventReward = {
  xp?: {
    action: Parameters<typeof grant>[2]
    source: (payload: never) => Parameters<typeof grant>[3]
    description: (payload: never) => string
    recipients?: (payload: never) => string[]
  }
  achievement?: Parameters<typeof grantAchievement>[2]
}

/**
 * The rewards engine's subscriber: pays what EVENT_REWARDS says for the event,
 * on the emitter's transaction. Returns whether anything new was paid.
 */
export async function payForEvent(context: TransactionalContext<DomainEventName>): Promise<EmitResult> {
  const reward = EVENT_REWARDS[context.name] as AnyEventReward
  const userId = (context.payload as { userId: string }).userId
  let rewarded = false

  // Endorsements pay the owner, XP and achievement alike, only when the endorsement rules allow it.
  if (context.name === 'EVIDENCE_ENDORSED') {
    const { endorserId } = context.payload as { endorserId: string }
    if (!(await endorsementRewardAllowed(context.tx as Parameters<typeof endorsementRewardAllowed>[0], userId, endorserId))) {
      return { rewarded: false }
    }
  }

  // Accepted applications pay the applicant, XP and achievement alike, only when the account passes the age and email checks.
  if (context.name === 'TEAM_APPLICATION_ACCEPTED') {
    const applicant = await context.tx.user.findUnique({ where: { id: userId }, select: { createdAt: true, isEmailVerified: true } })
    if (!applicant || !applicantRewardEligible(applicant)) return { rewarded: false }
  }

  if (reward.xp) {
    const payload = context.payload as never
    const source = reward.xp.source(payload)
    const description = reward.xp.description(payload)
    // Paid in a fixed order (by id), so two transactions that reward the same pair of
    // users take their locks in the same order and cannot deadlock each other.
    const recipients = reward.xp.recipients ? [...new Set(reward.xp.recipients(payload))].sort() : [userId]
    for (const recipient of recipients) {
      const result = await grant(context.tx, recipient, reward.xp.action, { ...source, description })
      if (result.granted) rewarded = true
    }
  }

  if (reward.achievement && (await grantAchievement(context.tx, userId, reward.achievement)).granted) rewarded = true

  return { rewarded }
}

export function registerSubscribers(target: EventBus = bus) {
  for (const name of Object.keys(EVENT_REWARDS) as DomainEventName[]) {
    const reward = EVENT_REWARDS[name] as AnyEventReward
    if (reward.xp || reward.achievement) {
      target.onTransactional(name, (context) => payForEvent(context as TransactionalContext<DomainEventName>))
    }
  }

  // After commit only: a rolled-back action is not counted.
  target.onCommitted('PROJECT_CREATED', ({ payload }) => track(payload.userId, 'project_created', { projectId: payload.projectId }))
  target.onCommitted('PROJECT_SHIPPED', ({ payload }) => track(payload.userId, 'project_shipped', { projectId: payload.projectId }))
}

// Registered once per bus, however many times a bundler evaluates this module.
bus.registerOnce('subscribers', () => registerSubscribers(bus))
