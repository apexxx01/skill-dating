import type { DeliveryChannel } from '@prisma/client'
import { inQuietHours, quietEndsAt, type QuietWindow } from './quiet'
import { channelPolicy, CHANNEL_LIMITS, groupOf, POLICY, STALE_AFTER_MS, type DeliveryKind, type RateLimit } from './policy'

// The decision for one notification on one channel, as a pure function of the facts the pipeline gathers (dispatch.ts). Keeping it free of the database is what makes
// every rule below testable on its own, and the order of the rules is the contract (docs/NOTIFICATIONS.md): the first that applies wins.

export interface DeliverySettings extends QuietWindow {
  emailEnabled: boolean
  pushEnabled: boolean
  dailyDigest: boolean
  weeklyDigest: boolean
}

export const DEFAULT_SETTINGS: DeliverySettings = { emailEnabled: true, pushEnabled: true, enabled: true, start: 22 * 60, end: 8 * 60, dailyDigest: true, weeklyDigest: true }

export type SkipReason = 'CHANNEL_OFF' | 'NO_DESTINATION' | 'NO_CONSENT' | 'SUPPRESSED' | 'DUPLICATE' | 'RATE_LIMIT' | 'STALE'

/** Skips worth a row in the delivery log (something that would have been sent was held back); the others are the normal state of a channel nobody uses. */
export const RECORDED_SKIPS: ReadonlySet<SkipReason> = new Set(['SUPPRESSED', 'DUPLICATE', 'RATE_LIMIT', 'STALE'])

export type Decision = { action: 'SEND' } | { action: 'DEFER'; until: Date; reason: 'QUIET_HOURS' } | { action: 'SKIP'; reason: SkipReason }

export interface RecentSend {
  kind: DeliveryKind
  sentAt: Date
}

export interface DeliveryFacts {
  now: Date
  kind: DeliveryKind
  channel: DeliveryChannel
  timezone: string | null
  settings: DeliverySettings
  /** The person's own choice for this kind on this channel, or undefined if they never made one. */
  preference: boolean | undefined
  /** Whether the MARKETING consent is in force. */
  marketingConsent: boolean
  /** EMAIL: a verified address exists. PUSH: at least one subscription exists. */
  hasDestination: boolean
  /** EMAIL only: the address bounced or complained. */
  suppressed: boolean
  /** The same thing was already delivered on this channel (the unique key), or a notification of the same kind about the same place lately. */
  duplicate: boolean
  /** What was sent to this person on this channel in the last 24 hours (the widest window there is). */
  recent: readonly RecentSend[]
  /** When the notification was written. Undefined for something generated at the moment of sending (a digest). */
  createdAt?: Date
}

const countWithin = (sends: readonly RecentSend[], now: Date, windowMs: number, match: (send: RecentSend) => boolean) =>
  sends.filter((send) => match(send) && now.getTime() - send.sentAt.getTime() < windowMs).length

const exceeds = (sends: readonly RecentSend[], now: Date, limit: RateLimit, match: (send: RecentSend) => boolean) => countWithin(sends, now, limit.windowMs, match) >= limit.max

export function decideDelivery(facts: DeliveryFacts): Decision {
  const { kind, channel, now } = facts
  const policy = POLICY[kind]
  const channelRules = channelPolicy(kind, channel)
  const security = policy.class === 'SECURITY'

  if (channelRules.unavailable) return { action: 'SKIP', reason: 'CHANNEL_OFF' }
  if (!facts.hasDestination) return { action: 'SKIP', reason: 'NO_DESTINATION' }
  if (channel === 'EMAIL' && facts.suppressed) return { action: 'SKIP', reason: 'SUPPRESSED' }

  if (!security) {
    const globalOn = channel === 'EMAIL' ? facts.settings.emailEnabled : facts.settings.pushEnabled
    if (!globalOn) return { action: 'SKIP', reason: 'CHANNEL_OFF' }
    if (!(facts.preference ?? channelRules.default)) return { action: 'SKIP', reason: 'CHANNEL_OFF' }
    if (policy.class === 'PROMOTIONAL' && !facts.marketingConsent) return { action: 'SKIP', reason: 'NO_CONSENT' }
  }

  if (facts.duplicate) return { action: 'SKIP', reason: 'DUPLICATE' }
  if (facts.createdAt && now.getTime() - facts.createdAt.getTime() > STALE_AFTER_MS) return { action: 'SKIP', reason: 'STALE' }

  if (!security && inQuietHours(now, facts.timezone, facts.settings)) {
    return { action: 'DEFER', until: quietEndsAt(now, facts.timezone, facts.settings), reason: 'QUIET_HOURS' }
  }

  const group = groupOf(kind)
  if (channelRules.limit && exceeds(facts.recent, now, channelRules.limit, (send) => groupOf(send.kind) === group)) return { action: 'SKIP', reason: 'RATE_LIMIT' }
  // Account notices are exempt from the channel-wide limits; a flood of them is a bug to see, not something to hide.
  if (!security) {
    // Digests have their own cadence (once a local day or week); the limits are for notifications.
    const counted = (send: RecentSend) => POLICY[send.kind].class !== 'SECURITY' && !POLICY[send.kind].ownCadence
    if (!policy.ownCadence && CHANNEL_LIMITS[channel].some((limit) => exceeds(facts.recent, now, limit, counted))) return { action: 'SKIP', reason: 'RATE_LIMIT' }
  }
  return { action: 'SEND' }
}
