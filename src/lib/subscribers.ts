import { bus, type DomainEventName, type EmitResult, type EventBus, type TransactionalContext } from '@/lib/events'
import { grantAchievement } from '@/lib/achievements'
import { track } from '@/lib/infra/analytics'
import { grant } from '@/lib/rewards'
import { EVENT_REWARDS } from '@/lib/rewards-config'
import { endorsementRewardAllowed } from '@/lib/skill-evidence'

// Who listens to what. This module is loaded by the bus before the first event
// (see events.ts), so a route only has to emit.

type AnyEventReward = {
  xp?: {
    action: Parameters<typeof grant>[2]
    source: (payload: never) => Parameters<typeof grant>[3]
    description: (payload: never) => string
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

  if (reward.xp) {
    const payload = context.payload as never
    const source = reward.xp.source(payload)
    const result = await grant(context.tx, userId, reward.xp.action, { ...source, description: reward.xp.description(payload) })
    if (result.granted) rewarded = true
  }

  if (reward.achievement) {
    // Endorsements pay the owner only when the endorsement rules allow it.
    const allowed =
      context.name !== 'EVIDENCE_ENDORSED' ||
      (await endorsementRewardAllowed(context.tx as Parameters<typeof endorsementRewardAllowed>[0], userId, (context.payload as { endorserId: string }).endorserId))
    if (allowed && (await grantAchievement(context.tx, userId, reward.achievement)).granted) rewarded = true
  }

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

// Registered once, whatever number of times the module is evaluated by a bundler.
const registered = globalThis as unknown as { __subscribersRegistered?: boolean }
if (!registered.__subscribersRegistered) {
  registered.__subscribersRegistered = true
  registerSubscribers()
}
