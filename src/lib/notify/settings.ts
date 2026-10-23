import { createHash } from 'crypto'
import type { DeliveryChannel, Prisma, PrismaClient } from '@prisma/client'
import { consentStates } from '@/lib/privacy/consent'
import { DEFAULT_SETTINGS, type DeliverySettings } from './decide'
import { channelPolicy, DELIVERY_KINDS, POLICY, switchableKinds, type DeliveryKind } from './policy'
import { formatMinutes } from './quiet'
import type { UnsubscribeScope } from './tokens'

// The person's delivery choices: the global switches and quiet hours (NotificationSettings), the per-kind per-channel choices (ChannelPreference), whether the
// MARKETING consent is in force, and which addresses bounced.

type Db = PrismaClient | Prisma.TransactionClient

export async function loadSettings(db: Pick<Db, 'notificationSettings'>, userId: string): Promise<DeliverySettings> {
  const row = await db.notificationSettings.findUnique({ where: { userId } })
  if (!row) return DEFAULT_SETTINGS
  return {
    emailEnabled: row.emailEnabled,
    pushEnabled: row.pushEnabled,
    enabled: row.quietEnabled,
    start: row.quietStart,
    end: row.quietEnd,
    dailyDigest: row.dailyDigest,
    weeklyDigest: row.weeklyDigest,
  }
}

export interface SettingsChanges {
  emailEnabled?: boolean
  pushEnabled?: boolean
  quietEnabled?: boolean
  quietStart?: number
  quietEnd?: number
  dailyDigest?: boolean
  weeklyDigest?: boolean
}

export async function saveSettings(db: Pick<Db, 'notificationSettings'>, userId: string, changes: SettingsChanges): Promise<DeliverySettings> {
  await db.notificationSettings.upsert({ where: { userId }, create: { userId, ...changes }, update: changes })
  return loadSettings(db, userId)
}

/** The person's explicit choices, keyed `KIND:CHANNEL`. A kind with no entry is at its default. */
export async function loadChannelChoices(db: Pick<Db, 'channelPreference'>, userId: string): Promise<Map<string, boolean>> {
  const rows = await db.channelPreference.findMany({ where: { userId }, select: { kind: true, channel: true, enabled: true } })
  return new Map(rows.map((row) => [`${row.kind}:${row.channel}`, row.enabled]))
}

export const choiceKey = (kind: DeliveryKind, channel: DeliveryChannel) => `${kind}:${channel}`

export async function setChannelChoice(db: Pick<Db, 'channelPreference'>, userId: string, kind: DeliveryKind, channel: DeliveryChannel, enabled: boolean): Promise<void> {
  await db.channelPreference.upsert({ where: { userId_kind_channel: { userId, kind, channel } }, create: { userId, kind, channel, enabled }, update: { enabled } })
}

export interface ChannelView {
  kind: DeliveryKind
  label: string
  class: 'ACTIVITY' | 'PROMOTIONAL'
  email: { enabled: boolean; default: boolean; available: boolean }
  push: { enabled: boolean; default: boolean; available: boolean }
}

/** Every kind a person can switch, with what is on for them now on each channel. */
export function channelViews(choices: ReadonlyMap<string, boolean>): ChannelView[] {
  return switchableKinds().map((kind) => {
    const one = (channel: DeliveryChannel) => {
      const rules = channelPolicy(kind, channel)
      return { enabled: !rules.unavailable && (choices.get(choiceKey(kind, channel)) ?? rules.default), default: rules.default, available: !rules.unavailable }
    }
    return { kind, label: POLICY[kind].label, class: POLICY[kind].class as 'ACTIVITY' | 'PROMOTIONAL', email: one('EMAIL'), push: one('PUSH') }
  })
}

export function settingsView(settings: DeliverySettings) {
  return {
    emailEnabled: settings.emailEnabled,
    pushEnabled: settings.pushEnabled,
    quietHours: { enabled: settings.enabled, start: formatMinutes(settings.start), end: formatMinutes(settings.end) },
    dailyDigest: settings.dailyDigest,
    weeklyDigest: settings.weeklyDigest,
  }
}

/** Whether the person gave the MARKETING consent and has not withdrawn it. A grant of an older version of the text still counts: it was given, and not withdrawn. */
export async function hasMarketingConsent(db: Pick<Db, 'consentRecord'>, userId: string): Promise<boolean> {
  const records = await db.consentRecord.findMany({ where: { userId, type: 'MARKETING' }, select: { type: true, version: true, grantedAt: true, withdrawnAt: true } })
  return consentStates(records).MARKETING.grantedVersion !== null
}

/** What the suppression list stores for an address: the SHA-256 of the trimmed, lower-cased address as hex. The address itself is never kept. */
export const suppressionKey = (email: string): string => createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex')

export async function isSuppressed(db: Pick<Db, 'emailSuppression'>, email: string): Promise<boolean> {
  return (await db.emailSuppression.findUnique({ where: { emailHash: suppressionKey(email) }, select: { id: true } })) !== null
}

export async function suppressAddress(db: Pick<Db, 'emailSuppression'>, email: string, reason: 'BOUNCE' | 'COMPLAINT'): Promise<void> {
  // A complaint outweighs a bounce: the person asked not to be mailed.
  const emailHash = suppressionKey(email)
  await db.emailSuppression.upsert({ where: { emailHash }, create: { emailHash, reason }, update: reason === 'COMPLAINT' ? { reason } : {} })
}

/**
 * Applies an unsubscribe link: one kind's email off, or (ALL) every optional email off, digests included. Idempotent. Account notices are not affected: they are
 * not a choice (policy.ts), and a link cannot switch off what the policy says is always sent.
 */
export async function applyUnsubscribe(db: Db, scope: UnsubscribeScope): Promise<{ applied: boolean }> {
  const user = await db.user.findUnique({ where: { id: scope.userId }, select: { id: true } })
  if (!user) return { applied: false }
  if (scope.kind === 'ALL') {
    await saveSettings(db, scope.userId, { emailEnabled: false, dailyDigest: false, weeklyDigest: false })
    return { applied: true }
  }
  if (scope.kind === 'NEUTRAL') {
    for (const kind of DELIVERY_KINDS) if (POLICY[kind].exposure === 'NEUTRAL' && !POLICY[kind].email.unavailable) await setChannelChoice(db, scope.userId, kind, 'EMAIL', false)
    return { applied: true }
  }
  if (POLICY[scope.kind].class === 'SECURITY') return { applied: false }
  await setChannelChoice(db, scope.userId, scope.kind, 'EMAIL', false)
  return { applied: true }
}
