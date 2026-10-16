import { bus, DOMAIN_EVENT_NAMES, type DomainEventName, type EmitResult, type EventBus, type TransactionalContext } from '@/lib/events'
import { advanceProgress, usersInvolved } from '@/lib/achievement-progress'
import { COSMETIC_EVENTS, unlockForEvent } from '@/lib/cosmetics'
import { track } from '@/lib/infra/analytics'
import { lockProgress } from '@/lib/metrics'
import { grant } from '@/lib/rewards'
import { EVENT_REWARDS } from '@/lib/rewards-config'
import { endorsementRewardAllowed } from '@/lib/skill-evidence'
import { peerPairsOf, withheldSubjects } from '@/lib/trust'

// Who listens to what. This module is loaded by the bus before the first event
// (see events.ts), so a route only has to emit.

type AnyEventReward = {
  xp?: {
    action: Parameters<typeof grant>[2]
    source: (payload: never) => Parameters<typeof grant>[3]
    description: (payload: never) => string
    recipients?: (payload: never) => string[]
  }
}

/**
 * The rewards engine's subscriber, for every event: pays what EVENT_REWARDS says on the emitter's
 * transaction, then counts the event (metrics.ts) and unlocks what the counts reach
 * (achievement-progress.ts). Returns whether anything new was paid or unlocked.
 *
 * Only an award that actually paid is counted, so the daily caps, the once-per-source rule and the
 * gates below limit achievements and quests exactly as they limit XP.
 */
export async function payForEvent(context: TransactionalContext<DomainEventName>): Promise<EmitResult> {
  const reward = EVENT_REWARDS[context.name] as AnyEventReward
  const userId = (context.payload as { userId: string }).userId
  let rewarded = false

  // Everyone the event touches is locked before any of them is written, in one fixed order, so two
  // requests that involve the same people cannot wait on each other.
  await lockProgress(context.tx, usersInvolved(context.name, context.payload))

  // A reward somebody else's action earns (an endorsement, an accepted application, a connection, a first message, a reply)
  // is paid only when that somebody is a trusted counterparty (src/lib/trust.ts). Whoever's counterparty is not trusted gets
  // nothing from the event: no XP, and nothing counted toward achievements or quests.
  const pairs = peerPairsOf(context.name, context.payload as never)
  const withheld = pairs.length > 0 ? await withheldSubjects(context.tx, pairs) : new Set<string>()
  if (pairs.length > 0 && pairs.every((pair) => withheld.has(pair.subjectId))) return { rewarded: false }

  // Endorsements also follow the endorsement rules: the endorser has some verification, and endorses for XP only so often a day.
  if (context.name === 'EVIDENCE_ENDORSED') {
    const { endorserId } = context.payload as { endorserId: string }
    if (!(await endorsementRewardAllowed(context.tx as Parameters<typeof endorsementRewardAllowed>[0], userId, endorserId))) {
      return { rewarded: false }
    }
  }

  const paid = new Set<string>()
  if (reward.xp) {
    const payload = context.payload as never
    const source = reward.xp.source(payload)
    const description = reward.xp.description(payload)
    // Paid in a fixed order (by id), so two transactions that reward the same pair of
    // users take their locks in the same order and cannot deadlock each other.
    const recipients = (reward.xp.recipients ? [...new Set(reward.xp.recipients(payload))].sort() : [userId]).filter((recipient) => !withheld.has(recipient))
    for (const recipient of recipients) {
      // Of the people a connection pays, only the one who accepted acted; the other just received it.
      const result = await grant(context.tx, recipient, reward.xp.action, { ...source, description, actor: recipient === userId })
      if (result.granted) {
        rewarded = true
        paid.add(recipient)
      }
    }
  }

  const { unlocked } = await advanceProgress(context.tx, context.name, context.payload, paid)
  if (unlocked > 0) rewarded = true

  return { rewarded }
}

export function registerSubscribers(target: EventBus = bus) {
  for (const name of DOMAIN_EVENT_NAMES) {
    target.onTransactional(name, (context) => payForEvent(context as TransactionalContext<DomainEventName>))
  }

  // The cosmetics a tier, an achievement or a streak earns. This, and nothing else, grants a cosmetic.
  for (const name of COSMETIC_EVENTS) target.onTransactional(name, (context) => unlockForEvent(context as TransactionalContext<DomainEventName>))

  // After commit only: a rolled-back action is not counted.
  target.onCommitted('PROJECT_CREATED', ({ payload }) => track(payload.userId, 'project_created', { projectId: payload.projectId }))
  target.onCommitted('PROJECT_SHIPPED', ({ payload }) => track(payload.userId, 'project_shipped', { projectId: payload.projectId }))
}

// Registered once per bus, however many times a bundler evaluates this module.
bus.registerOnce('subscribers', () => registerSubscribers(bus))
