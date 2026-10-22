import type { DeliveryChannel, NotificationType } from '@prisma/client'
import { NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notification-kinds'

// The channel policy: for every kind of notification, whether it may leave the app by email or web push, what the default is, how often, and what class it is.
// Pure data, read by the pipeline (dispatch.ts), the preferences route and the unsubscribe links. docs/NOTIFICATIONS.md is the readable version.
//
// In-app is always on (and has its own switches, src/lib/notifications.ts). The other channels are decided here:
//   SECURITY     account, safety and legal notices (a moderation decision, an appeal, a data export). Email and push cannot be switched off per kind or by "unsubscribe
//                from all" and ignore quiet hours; a bounced address still stops them.
//   ACTIVITY     something somebody did to the person, or asked of them (a message, an invitation, a spark, Props). Opt-out per kind and channel; an unsubscribe link
//                in every email.
//   PROMOTIONAL  mail the platform starts on its own to bring a person back: digests. Needs the MARKETING consent, as well as everything an activity email needs.
// A kind the policy gives the NEUTRAL exposure is a romance-mode kind: only "You have a new message" ever leaves the app, never who or what (src/lib/notify/templates.ts).

export type DeliveryClass = 'SECURITY' | 'ACTIVITY' | 'PROMOTIONAL'

export interface RateLimit {
  max: number
  windowMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface ChannelPolicy {
  /** On until the person says otherwise. */
  default: boolean
  /** The most deliveries of this kind (or of its `group`) a person gets on this channel in a window. Absent: only the channel-wide limits apply. */
  limit?: RateLimit
  /** The kind is never sent on this channel and the person cannot switch it on (a digest by push). */
  unavailable?: boolean
}

export interface KindPolicy {
  /** What the switch is called in settings. */
  label: string
  class: DeliveryClass
  email: ChannelPolicy
  push: ChannelPolicy
  /**
   * What of the notification leaves the app. FULL (default): its title and text. ACCOUNT: only that there is an account notice (a moderation decision is not for a lock
   * screen). NEUTRAL: only "You have a new message" (the romance mode: nothing about it, not even that it is about it, is shown outside the app).
   */
  exposure?: 'FULL' | 'ACCOUNT' | 'NEUTRAL'
  /** Kinds that share one limit count together (all the romance kinds are one). Default: the kind alone. */
  group?: string
  urgency: 'low' | 'normal' | 'high'
}

/** Across every kind but SECURITY: no more than this on a channel. */
export const CHANNEL_LIMITS: Record<DeliveryChannel, RateLimit[]> = {
  EMAIL: [{ max: 6, windowMs: DAY }],
  PUSH: [
    { max: 3, windowMs: HOUR },
    { max: 10, windowMs: DAY },
  ],
}

/** Browsers one account can register for push (a phone, a laptop, a desktop, and a few spare). */
export const MAX_PUSH_DEVICES = 10

/** A held notification older than this is dropped, not sent: nobody wants yesterday's "someone commented" at breakfast. */
export const STALE_AFTER_MS = 18 * HOUR

/** Held deliveries released together for one person: more than this are folded into one "N new notifications". */
export const RELEASE_INDIVIDUALLY = 2

// Kinds that exist only as a policy key (written directly by other modules, or resolved from the notification's type), beside the NotificationKind ones.
export const EXTRA_KINDS = [
  'MODERATION',
  'DATA_EXPORT',
  'LEVEL_UP',
  'TIER_UP',
  'ACHIEVEMENT_UNLOCKED',
  'COSMETIC_UNLOCKED',
  'QUEST_COMPLETED',
  'SKILL_EVIDENCE_ENDORSED',
  'MATCH_CREATED',
  // Resolved from NotificationType when a notification names no kind.
  'NEW_MESSAGE',
  'TEAM_INVITATION',
  'JOIN_REQUEST',
  'HACKATHON_REMINDER',
  'PROJECT_UPDATE',
  'ACHIEVEMENT',
  'CHALLENGE_COMPLETION',
  'CONNECTION',
  'MENTION',
  'APPLICATION_RESPONSE',
  'SYSTEM',
  'MATCH',
  // Romance-mode messages and matches, told apart from the professional ones by what the notification points at.
  'ROMANCE_MESSAGE',
  'ROMANCE_MATCH',
  // The digests (digest.ts), which are emails of their own, not notifications.
  'DIGEST_DAILY',
  'DIGEST_WEEKLY',
] as const

export type DeliveryKind = NotificationKind | (typeof EXTRA_KINDS)[number]

export const DELIVERY_KINDS: readonly DeliveryKind[] = [...new Set<DeliveryKind>([...NOTIFICATION_KINDS, ...EXTRA_KINDS])]

const none: ChannelPolicy = { default: false }
const never: ChannelPolicy = { default: false, unavailable: true }
const perHour = (max: number): RateLimit => ({ max, windowMs: HOUR })
const perDay = (max: number): RateLimit => ({ max, windowMs: DAY })

const ROMANCE_LIMIT: RateLimit = { max: 3, windowMs: DAY }

export const POLICY: Record<DeliveryKind, KindPolicy> = {
  // --- Matching ---
  SPARK: { label: 'Someone sparked you', class: 'ACTIVITY', email: none, push: { default: true, limit: perHour(4) }, urgency: 'normal' },
  // The daily count is already in the in-app list and in the daily digest.
  SPARK_DIGEST: { label: 'The daily count of sparks', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  MATCH_CREATED: { label: 'A new match', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'high' },
  MATCH: { label: 'A new match', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'high' },
  NEW_MESSAGE: { label: 'New messages', class: 'ACTIVITY', email: { default: true, limit: perDay(3) }, push: { default: true, limit: perHour(3) }, urgency: 'high' },
  CONNECTION: { label: 'Connection requests and answers', class: 'ACTIVITY', email: { default: true, limit: perDay(3) }, push: { default: true, limit: perHour(3) }, urgency: 'normal' },

  // --- The romance mode: neutral line only, never the content, one shared limit ---
  ROMANCE_DROP: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: { default: false, limit: ROMANCE_LIMIT }, push: { default: true, limit: ROMANCE_LIMIT }, urgency: 'low' },
  ROMANCE_SPARK: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: { default: false, limit: ROMANCE_LIMIT }, push: { default: true, limit: ROMANCE_LIMIT }, urgency: 'normal' },
  ROMANCE_SPARK_DIGEST: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: never, push: never, urgency: 'low' },
  ROMANCE_REVEAL: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: { default: false, limit: ROMANCE_LIMIT }, push: { default: true, limit: ROMANCE_LIMIT }, urgency: 'normal' },
  ROMANCE_DUO: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: { default: false, limit: ROMANCE_LIMIT }, push: { default: true, limit: ROMANCE_LIMIT }, urgency: 'normal' },
  ROMANCE_MESSAGE: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: { default: false, limit: ROMANCE_LIMIT }, push: { default: true, limit: ROMANCE_LIMIT }, urgency: 'normal' },
  ROMANCE_MATCH: { label: 'Activity in a private mode', class: 'ACTIVITY', exposure: 'NEUTRAL', group: 'ROMANCE', email: { default: false, limit: ROMANCE_LIMIT }, push: { default: true, limit: ROMANCE_LIMIT }, urgency: 'normal' },

  // --- The feed ---
  PROPS: { label: 'Props on your posts', class: 'ACTIVITY', email: none, push: { default: true, limit: perHour(2) }, urgency: 'low' },
  COMMENT: { label: 'Comments and replies', class: 'ACTIVITY', email: { default: false, limit: perDay(3) }, push: { default: true, limit: perHour(3) }, urgency: 'normal' },
  FOLLOW: { label: 'New followers', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  WATCH: { label: 'Posts on projects you watch', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  MENTION: { label: 'Mentions', class: 'ACTIVITY', email: { default: true, limit: perDay(3) }, push: { default: true, limit: perHour(3) }, urgency: 'normal' },

  // --- Squads and crews ---
  SQUAD_INVITE: { label: 'Invitations to join a squad', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'high' },
  SQUAD_PROPOSAL: { label: 'Squads proposed to you', class: 'ACTIVITY', email: { default: true, limit: perDay(3) }, push: { default: true, limit: perHour(3) }, urgency: 'high' },
  SQUAD_REMINDER: { label: 'Reminders to find a team', class: 'ACTIVITY', email: { default: true, limit: perDay(2) }, push: { default: true, limit: perDay(2) }, urgency: 'normal' },
  SQUAD_UPDATE: { label: 'Changes to your squad', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'normal' },
  PEER_REVIEW: { label: 'Asks to review your teammates', class: 'ACTIVITY', email: { default: true, limit: perDay(2) }, push: none, urgency: 'low' },
  TEAM_INVITATION: { label: 'Invitations to join a team', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'high' },
  JOIN_REQUEST: { label: 'Requests to join your team', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'normal' },
  APPLICATION_RESPONSE: { label: 'Answers to your applications', class: 'ACTIVITY', email: { default: true, limit: perDay(5) }, push: { default: true, limit: perHour(3) }, urgency: 'normal' },
  HACKATHON_REMINDER: { label: 'Hackathon reminders', class: 'ACTIVITY', email: { default: true, limit: perDay(2) }, push: { default: true, limit: perDay(2) }, urgency: 'normal' },
  PROJECT_UPDATE: { label: 'Updates on your projects', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },

  // --- Progress ---
  LEVEL_UP: { label: 'Level ups', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  TIER_UP: { label: 'New tiers', class: 'ACTIVITY', email: none, push: { default: true, limit: perDay(2) }, urgency: 'low' },
  ACHIEVEMENT_UNLOCKED: { label: 'Achievements', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  ACHIEVEMENT: { label: 'Achievements', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  COSMETIC_UNLOCKED: { label: 'New cosmetics', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  QUEST_COMPLETED: { label: 'Completed quests', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  CHALLENGE_COMPLETION: { label: 'Challenge results', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },
  SKILL_EVIDENCE_ENDORSED: { label: 'Endorsements', class: 'ACTIVITY', email: { default: false, limit: perDay(3) }, push: { default: true, limit: perHour(2) }, urgency: 'low' },

  // --- Account and safety ---
  MODERATION: { label: 'Account and safety notices', class: 'SECURITY', exposure: 'ACCOUNT', email: { default: true, limit: perDay(10) }, push: { default: true, limit: perDay(10) }, urgency: 'high' },
  DATA_EXPORT: { label: 'Your data export', class: 'SECURITY', email: { default: true, limit: perDay(10) }, push: none, urgency: 'normal' },
  SYSTEM: { label: 'Other notices from the platform', class: 'ACTIVITY', email: none, push: none, urgency: 'low' },

  // --- Digests: mail the platform starts itself ---
  DIGEST_DAILY: { label: 'The daily digest', class: 'PROMOTIONAL', email: { default: true }, push: never, urgency: 'low' },
  DIGEST_WEEKLY: { label: 'The weekly digest', class: 'PROMOTIONAL', email: { default: true }, push: never, urgency: 'low' },
}

export const isDeliveryKind = (value: unknown): value is DeliveryKind => typeof value === 'string' && (DELIVERY_KINDS as readonly string[]).includes(value)

/** What a notification of this stored type is, when it names no kind of its own. */
export const KIND_OF_TYPE: Record<NotificationType, DeliveryKind> = {
  NEW_MESSAGE: 'NEW_MESSAGE',
  TEAM_INVITATION: 'TEAM_INVITATION',
  JOIN_REQUEST: 'JOIN_REQUEST',
  HACKATHON_REMINDER: 'HACKATHON_REMINDER',
  PROJECT_UPDATE: 'PROJECT_UPDATE',
  ACHIEVEMENT: 'ACHIEVEMENT',
  CHALLENGE_COMPLETION: 'CHALLENGE_COMPLETION',
  CONNECTION: 'CONNECTION',
  MENTION: 'MENTION',
  APPLICATION_RESPONSE: 'APPLICATION_RESPONSE',
  SYSTEM: 'SYSTEM',
  MATCH: 'MATCH',
  PROPS: 'PROPS',
  COMMENT: 'COMMENT',
  FOLLOW: 'FOLLOW',
  WATCH: 'WATCH',
  SPARK: 'SPARK',
}

export interface NotificationLike {
  type: NotificationType
  metadata: unknown
}

const metadataOf = (notification: NotificationLike): Record<string, unknown> =>
  notification.metadata && typeof notification.metadata === 'object' && !Array.isArray(notification.metadata) ? (notification.metadata as Record<string, unknown>) : {}

/**
 * The delivery kind of a notification: the kind it names in its metadata, or the one its type stands for. A professional-looking kind that points at the romance
 * mode (a match whose connection type is DATING) is turned into its neutral twin here; a message in a romance conversation is told apart in the pipeline, which can
 * look the conversation up (dispatch.ts).
 */
export function deliveryKindOf(notification: NotificationLike): DeliveryKind {
  const metadata = metadataOf(notification)
  const named = metadata.kind
  let kind: DeliveryKind = isDeliveryKind(named) ? named : KIND_OF_TYPE[notification.type]
  if (metadata.connectionType === 'DATING') {
    if (kind === 'MATCH_CREATED' || kind === 'MATCH') kind = 'ROMANCE_MATCH'
    else if (kind === 'NEW_MESSAGE') kind = 'ROMANCE_MESSAGE'
  }
  return kind
}

/** The kinds a person can switch per channel in settings: every one that is not a notice they must receive. */
export function switchableKinds(): DeliveryKind[] {
  return DELIVERY_KINDS.filter((kind) => POLICY[kind].class !== 'SECURITY')
}

export const channelPolicy = (kind: DeliveryKind, channel: DeliveryChannel): ChannelPolicy => (channel === 'EMAIL' ? POLICY[kind].email : POLICY[kind].push)

/** The group a kind counts its limit in. */
export const groupOf = (kind: DeliveryKind): string => POLICY[kind].group ?? kind

/** Every kind that counts in the same limit group as `kind`. */
export const kindsInGroup = (kind: DeliveryKind): DeliveryKind[] => DELIVERY_KINDS.filter((other) => groupOf(other) === groupOf(kind))
