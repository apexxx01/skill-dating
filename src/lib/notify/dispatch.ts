import { Prisma, type DeliveryChannel, type Notification, type NotificationDelivery, type PrismaClient, type PushSubscription } from '@prisma/client'
import { EmailSendError, getEmail, type EmailSender } from '@/lib/infra/email'
import { getPush, type PushSender } from '@/lib/infra/push'
import { log } from '@/lib/log'
import { isKilled } from '@/lib/ops/kill-switches'
import { utcTimestamp } from '@/lib/sql'
import { appBaseUrl } from './base-url'
import { decideDelivery, RECORDED_SKIPS, type DeliveryFacts, type DeliverySettings, type RecentSend } from './decide'
import { deliveryKindOf, isDeliveryKind, POLICY, RELEASE_INDIVIDUALLY, type DeliveryKind } from './policy'
import { hasMarketingConsent, isSuppressed, loadChannelChoices, loadSettings, choiceKey } from './settings'
import { localeFor, t, type Locale } from './strings'
import { openToken, unsubscribeToken } from './tokens'
import { renderNotificationEmail, renderPush, visibleContent, type FooterLinks, type RenderedEmail } from './templates'

// The delivery pipeline: what leaves the app, when, and to whom. One path for every notification, whoever wrote it.
//
//   sweepNotifications   claims the notifications nobody has looked at yet (Notification.sweptAt IS NULL), and for each decides, per channel, with decideDelivery()
//                        (decide.ts): send, hold until quiet hours end, or skip. Every writer of a notification is covered without knowing about delivery.
//   releaseDeferred      sends what was held (quiet hours ended, or a failed attempt is due again), folding a pile of them into one "N new notifications".
//
// Both are safe to repeat and to run twice at once: a notification is claimed with FOR UPDATE SKIP LOCKED, and NotificationDelivery's unique key (user, channel,
// what it is of) makes a second delivery of the same thing impossible. The digests (digest.ts) send through the same two senders below.

export interface DispatchDeps {
  email: EmailSender
  push: PushSender
  /** The address of the app, without a trailing slash, for the absolute links in emails. */
  baseUrl: string
  now?: Date
}

export function defaultDeps(): DispatchDeps {
  return { email: getEmail(), push: getPush(), baseUrl: appBaseUrl() }
}

const CHANNELS: DeliveryChannel[] = ['EMAIL', 'PUSH']
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** Attempts at one delivery before it is given up on, and how long to wait before each retry. */
export const MAX_ATTEMPTS = 4
const RETRY_DELAYS_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS]
/** Devices a push goes to: the most recently registered. */
export const MAX_DEVICES = 5
/** A subscription that failed this many times in a row (not "gone": failed) is dropped. */
const MAX_PUSH_FAILURES = 10
/** How long a delivery that is being sent is left alone by the release job: a send that dies midway is tried again after this. */
const REPEAT_AFTER_MS = 15 * MINUTE_MS
const SAME_PLACE_WINDOW_MS = HOUR_MS

export interface UserContext {
  id: string
  /** The address mail goes to, or null: no verified address, or the account is deleted. */
  email: string | null
  name: string | null
  timezone: string | null
  locale: Locale
  settings: DeliverySettings
  choices: Map<string, boolean>
  marketing: boolean
  suppressed: boolean
  subscriptions: PushSubscription[]
  recent: Record<DeliveryChannel, RecentSend[]>
}

/** Everything the pipeline needs to know about one person, in a handful of queries. Null for a person who is gone. */
export async function loadContext(db: PrismaClient, userId: string, now: Date): Promise<UserContext | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, username: true, timezone: true, isEmailVerified: true, deletedAt: true } })
  if (!user || user.deletedAt) return null
  const [settings, choices, marketing, subscriptions, recentRows] = await Promise.all([
    loadSettings(db, userId),
    loadChannelChoices(db, userId),
    hasMarketingConsent(db, userId),
    db.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: MAX_DEVICES }),
    db.notificationDelivery.findMany({ where: { userId, status: 'SENT', sentAt: { gte: new Date(now.getTime() - 24 * HOUR_MS) } }, select: { kind: true, channel: true, sentAt: true } }),
  ])
  const address = user.isEmailVerified && user.email ? user.email : null
  const recent: UserContext['recent'] = { EMAIL: [], PUSH: [] }
  for (const row of recentRows) if (row.sentAt && isDeliveryKind(row.kind)) recent[row.channel].push({ kind: row.kind, sentAt: row.sentAt })
  return {
    id: user.id,
    email: address,
    name: user.name ?? null,
    timezone: user.timezone,
    locale: localeFor(user),
    settings,
    choices,
    marketing,
    suppressed: address ? await isSuppressed(db, address) : false,
    subscriptions,
    recent,
  }
}

function factsFor(ctx: UserContext, kind: DeliveryKind, channel: DeliveryChannel, now: Date, extra: Pick<DeliveryFacts, 'duplicate' | 'createdAt'>): DeliveryFacts {
  return {
    now,
    kind,
    channel,
    timezone: ctx.timezone,
    settings: ctx.settings,
    preference: ctx.choices.get(choiceKey(kind, channel)),
    marketingConsent: ctx.marketing,
    hasDestination: channel === 'EMAIL' ? ctx.email !== null : ctx.subscriptions.length > 0,
    suppressed: channel === 'EMAIL' && ctx.suppressed,
    recent: ctx.recent[channel],
    ...extra,
  }
}

// --- The kind of a notification ------------------------------------------------------------------------------------------

/**
 * The delivery kind, with the one thing the notification cannot say about itself: a message (or anything else that names a conversation or a match) in the romance
 * mode. The notification's own metadata is enough for the kinds that carry a connection type; for the rest the conversation or match is looked up.
 */
export async function resolveKind(db: Pick<PrismaClient, 'conversation' | 'match'>, notification: Pick<Notification, 'type' | 'metadata'>): Promise<DeliveryKind> {
  const kind = deliveryKindOf(notification)
  if (POLICY[kind].exposure === 'NEUTRAL') return kind
  const metadata = notification.metadata && typeof notification.metadata === 'object' && !Array.isArray(notification.metadata) ? (notification.metadata as Record<string, unknown>) : {}
  if (typeof metadata.matchId === 'string') {
    const match = await db.match.findUnique({ where: { id: metadata.matchId }, select: { connectionType: true } })
    if (match?.connectionType === 'DATING') return kind === 'NEW_MESSAGE' ? 'ROMANCE_MESSAGE' : 'ROMANCE_MATCH'
  }
  if (typeof metadata.conversationId === 'string') {
    const conversation = await db.conversation.findUnique({ where: { id: metadata.conversationId }, select: { match: { select: { connectionType: true } } } })
    if (conversation?.match?.connectionType === 'DATING') return kind === 'MATCH_CREATED' || kind === 'MATCH' ? 'ROMANCE_MATCH' : 'ROMANCE_MESSAGE'
  }
  return kind
}

// --- Links ----------------------------------------------------------------------------------------------------------------

const safePath = (link: string | null | undefined) => (link && link.startsWith('/') && !link.startsWith('//') ? link : '/notifications')

/** Where a tap or a click on this goes: the notification's own link, or the notification list when the kind does not show what it is about. */
export function destinationOf(kind: DeliveryKind, link: string | null | undefined): string {
  return (POLICY[kind].exposure ?? 'FULL') === 'FULL' ? safePath(link) : '/notifications'
}

export function footerFor(deps: Pick<DispatchDeps, 'baseUrl'>, userId: string, kind: DeliveryKind): FooterLinks {
  const security = POLICY[kind].class === 'SECURITY'
  const unsubscribe = (scope: DeliveryKind | 'ALL') => `${deps.baseUrl}/api/notifications/unsubscribe?t=${unsubscribeToken({ userId, kind: scope })}`
  return {
    ...(security ? {} : { stopKindUrl: unsubscribe(kind), stopAllUrl: unsubscribe('ALL') }),
    settingsUrl: `${deps.baseUrl}/settings/notifications`,
    kindLabel: POLICY[kind].label,
    account: security,
    digest: kind === 'DIGEST_DAILY' || kind === 'DIGEST_WEEKLY',
  }
}

/** The headers that make unsubscribing one click in a mail client (RFC 8058). None for an account notice, which is not optional. */
export function unsubscribeHeaders(deps: Pick<DispatchDeps, 'baseUrl'>, userId: string, kind: DeliveryKind): Record<string, string> {
  if (POLICY[kind].class === 'SECURITY') return {}
  return {
    'List-Unsubscribe': `<${deps.baseUrl}/api/notifications/unsubscribe?t=${unsubscribeToken({ userId, kind })}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export const openUrl = (deps: Pick<DispatchDeps, 'baseUrl'>, deliveryId: string, path: string) => `${deps.baseUrl}/api/notifications/open/${openToken(deliveryId, path)}`

// --- The two senders -------------------------------------------------------------------------------------------------------

export type SendOutcome = 'SENT' | 'RETRY' | 'FAILED' | 'GONE'

function retryOrFail(attempts: number, now: Date): { status: 'DEFERRED'; sendAfter: Date; reason: string } | { status: 'FAILED'; sendAfter: null; reason: string } {
  if (attempts >= MAX_ATTEMPTS) return { status: 'FAILED', sendAfter: null, reason: 'GAVE_UP' }
  return { status: 'DEFERRED', sendAfter: new Date(now.getTime() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]), reason: 'RETRY' }
}

/** Sends one email for a delivery row, and records what happened on it. */
export async function sendEmailFor(db: PrismaClient, deps: DispatchDeps, delivery: Pick<NotificationDelivery, 'id' | 'attempts' | 'userId'>, to: string, rendered: RenderedEmail, headers: Record<string, string>, now: Date, kind: DeliveryKind): Promise<SendOutcome> {
  const attempts = delivery.attempts + 1
  try {
    const sent = await deps.email.send({ to, subject: rendered.subject, html: rendered.html, text: rendered.text, headers, tags: { kind, delivery: delivery.id }, idempotencyKey: `delivery:${delivery.id}` })
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'SENT', reason: null, providerId: sent.id, attempts, sentAt: now, sendAfter: null } })
    return 'SENT'
  } catch (error) {
    const retryable = error instanceof EmailSendError ? error.retryable : true
    const next = retryable ? retryOrFail(attempts, now) : ({ status: 'FAILED', sendAfter: null, reason: 'REFUSED' } as const)
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: next.status, reason: next.reason, attempts, sendAfter: next.sendAfter } })
    log.warn('an email was not sent', { deliveryId: delivery.id, kind, attempts, retryable, error: error instanceof Error ? error.message : 'unknown' })
    return next.status === 'FAILED' ? 'FAILED' : 'RETRY'
  }
}

/** Sends one push to the person's devices for a delivery row, and records what happened. A device the push service says is gone is forgotten. */
export async function sendPushFor(db: PrismaClient, deps: DispatchDeps, delivery: Pick<NotificationDelivery, 'id' | 'attempts'>, subscriptions: PushSubscription[], payload: ReturnType<typeof renderPush>, urgency: 'low' | 'normal' | 'high', now: Date, kind: DeliveryKind): Promise<SendOutcome> {
  const attempts = delivery.attempts + 1
  let delivered = 0
  let retryable = 0
  for (const subscription of subscriptions) {
    const outcome = await deps.push.send({ endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth }, { ...payload, deliveryId: delivery.id }, { urgency, ttlSeconds: urgency === 'high' ? 24 * 3600 : 6 * 3600 })
    if (outcome.ok) {
      delivered += 1
      await db.pushSubscription.updateMany({ where: { id: subscription.id }, data: { lastUsedAt: now, failures: 0 } })
    } else if (outcome.gone) {
      await db.pushSubscription.deleteMany({ where: { id: subscription.id } })
    } else if (outcome.retryable) {
      retryable += 1
      const failed = await db.pushSubscription.update({ where: { id: subscription.id }, data: { failures: { increment: 1 } }, select: { failures: true } }).catch(() => null)
      if (failed && failed.failures >= MAX_PUSH_FAILURES) await db.pushSubscription.deleteMany({ where: { id: subscription.id } })
    }
  }
  if (delivered > 0) {
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'SENT', reason: null, attempts, sentAt: now, sendAfter: null } })
    return 'SENT'
  }
  if (retryable > 0) {
    const next = retryOrFail(attempts, now)
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: next.status, reason: next.reason, attempts, sendAfter: next.sendAfter } })
    return next.status === 'FAILED' ? 'FAILED' : 'RETRY'
  }
  // Every device was gone (or refused for good): nothing was sent and nothing will be.
  await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', reason: subscriptions.length > 0 ? 'GONE' : 'NO_DESTINATION', attempts, sendAfter: null } })
  return 'GONE'
}

// --- One notification ------------------------------------------------------------------------------------------------------

export interface SweepResult {
  claimed: number
  sent: number
  deferred: number
  skipped: number
  failed: number
}

const emptyResult = (): SweepResult => ({ claimed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0 })

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/** Creates the delivery row, or returns null when one for the same thing already exists (a repeat). */
async function openDelivery(db: PrismaClient, data: Prisma.NotificationDeliveryUncheckedCreateInput): Promise<NotificationDelivery | null> {
  try {
    return await db.notificationDelivery.create({ data })
  } catch (error) {
    if (isUniqueViolation(error)) return null
    throw error
  }
}

const dedupeKeyOf = (notification: Pick<Notification, 'id'>) => `n:${notification.id}`

/** The same kind about the same place, delivered lately: a second comment notification for the same post is not worth a second push. */
async function sentSameLately(db: PrismaClient, userId: string, channel: DeliveryChannel, kind: DeliveryKind, notification: Pick<Notification, 'id' | 'link'>, now: Date): Promise<boolean> {
  if (!notification.link) return false
  const found = await db.notificationDelivery.findFirst({
    where: { userId, channel, kind, status: 'SENT', sentAt: { gte: new Date(now.getTime() - SAME_PLACE_WINDOW_MS) }, notification: { link: notification.link, id: { not: notification.id } } },
    select: { id: true },
  })
  return found !== null
}

async function applyDecision(db: PrismaClient, deps: DispatchDeps, ctx: UserContext, notification: Notification, kind: DeliveryKind, channel: DeliveryChannel, decision: ReturnType<typeof decideDelivery>, now: Date, result: SweepResult) {
  const base = { userId: ctx.id, notificationId: notification.id, kind, channel, dedupeKey: dedupeKeyOf(notification) }
  if (decision.action === 'SKIP') {
    if (RECORDED_SKIPS.has(decision.reason)) await openDelivery(db, { ...base, status: 'SKIPPED', reason: decision.reason })
    result.skipped += 1
    return
  }
  if (decision.action === 'DEFER') {
    const row = await openDelivery(db, { ...base, status: 'DEFERRED', reason: decision.reason, sendAfter: decision.until })
    if (row) result.deferred += 1
    return
  }
  const row = await openDelivery(db, { ...base, status: 'DEFERRED', reason: 'SENDING', sendAfter: new Date(now.getTime() + REPEAT_AFTER_MS) })
  if (!row) {
    result.skipped += 1
    return
  }
  const outcome = await transmit(db, deps, ctx, row, notification, kind, now)
  if (outcome === 'SENT') result.sent += 1
  else if (outcome === 'RETRY') result.deferred += 1
  else result.failed += 1
}

/** Builds the message for a delivery of a notification and sends it on the delivery's channel. */
async function transmit(db: PrismaClient, deps: DispatchDeps, ctx: UserContext, delivery: NotificationDelivery, notification: Pick<Notification, 'title' | 'message' | 'link'>, kind: DeliveryKind, now: Date): Promise<SendOutcome> {
  const policy = POLICY[kind]
  const visible = visibleContent(policy.exposure, notification, ctx.locale)
  const path = destinationOf(kind, notification.link)
  let outcome: SendOutcome
  if (delivery.channel === 'EMAIL') {
    if (!ctx.email) {
      await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', reason: 'NO_DESTINATION' } })
      return 'FAILED'
    }
    const rendered = renderNotificationEmail({ locale: ctx.locale, name: ctx.name, visible, url: openUrl(deps, delivery.id, path), footer: footerFor(deps, ctx.id, kind), neutral: policy.exposure === 'NEUTRAL' })
    outcome = await sendEmailFor(db, deps, delivery, ctx.email, rendered, unsubscribeHeaders(deps, ctx.id, kind), now, kind)
  } else {
    outcome = await sendPushFor(db, deps, delivery, ctx.subscriptions, renderPush(visible, path, POLICY[kind].group ?? kind.toLowerCase()), policy.urgency, now, kind)
  }
  if (outcome === 'SENT') ctx.recent[delivery.channel].push({ kind, sentAt: now })
  return outcome
}

async function deliverNotification(db: PrismaClient, deps: DispatchDeps, contexts: Map<string, UserContext | null>, notification: Notification, now: Date, result: SweepResult) {
  if (!contexts.has(notification.userId)) contexts.set(notification.userId, await loadContext(db, notification.userId, now))
  const ctx = contexts.get(notification.userId)
  if (!ctx) return
  const kind = await resolveKind(db, notification)
  for (const channel of CHANNELS) {
    const duplicate = await sentSameLately(db, ctx.id, channel, kind, notification, now)
    const decision = decideDelivery(factsFor(ctx, kind, channel, now, { duplicate, createdAt: notification.createdAt }))
    await applyDecision(db, deps, ctx, notification, kind, channel, decision, now, result)
  }
}

// --- The sweep -------------------------------------------------------------------------------------------------------------

/** How many notifications one sweep takes. The job repeats every few minutes, so a backlog clears over runs rather than in one long one. */
export const SWEEP_BATCH = 200

export async function sweepNotifications(db: PrismaClient, deps: DispatchDeps = defaultDeps(), options: { limit?: number } = {}): Promise<SweepResult> {
  const now = deps.now ?? new Date()
  const result = emptyResult()
  // Claimed whether or not delivery is paused: a paused pipeline must not send a night's backlog the moment it is switched on (STALE drops what is too old anyway,
  // but a backlog from before the switch is stale news by any measure).
  const claimed = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "Notification" SET "sweptAt" = ${utcTimestamp(now)}
    WHERE "id" IN (SELECT "id" FROM "Notification" WHERE "sweptAt" IS NULL ORDER BY "createdAt" ASC LIMIT ${options.limit ?? SWEEP_BATCH} FOR UPDATE SKIP LOCKED)
    RETURNING "id"
  `)
  result.claimed = claimed.length
  if (claimed.length === 0) return result
  if (await isKilled(db, 'notification_delivery')) {
    log.warn('notification delivery is paused by its kill switch', { skipped: claimed.length })
    result.skipped = claimed.length
    return result
  }
  const notifications = await db.notification.findMany({ where: { id: { in: claimed.map((row) => row.id) } }, orderBy: { createdAt: 'asc' } })
  const contexts = new Map<string, UserContext | null>()
  for (const notification of notifications) {
    try {
      await deliverNotification(db, deps, contexts, notification, now, result)
    } catch (error) {
      result.failed += 1
      log.error('could not deliver a notification', { error, notificationId: notification.id })
    }
  }
  log.info('notification sweep', { ...result })
  return result
}

// --- Held deliveries -------------------------------------------------------------------------------------------------------

export interface ReleaseResult {
  claimed: number
  sent: number
  deferred: number
  skipped: number
  failed: number
  summarised: number
}

/**
 * Sends the deliveries that were held and are due. Each is judged again as if it were new (the person may have switched the kind off, or it may have gone stale);
 * someone with more than RELEASE_INDIVIDUALLY of them on one channel gets a single "N new notifications" instead of a pile.
 */
export async function releaseDeferred(db: PrismaClient, deps: DispatchDeps = defaultDeps(), options: { limit?: number } = {}): Promise<ReleaseResult> {
  const now = deps.now ?? new Date()
  const result: ReleaseResult = { ...emptyResult(), summarised: 0 }
  // Claimed by pushing their time forward: a run that dies leaves them to the next one a quarter of an hour later.
  const claimed = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "NotificationDelivery" SET "sendAfter" = ${utcTimestamp(new Date(now.getTime() + REPEAT_AFTER_MS))}
    WHERE "id" IN (
      SELECT "id" FROM "NotificationDelivery"
      WHERE "status" = 'DEFERRED' AND "sendAfter" <= ${utcTimestamp(now)} AND "notificationId" IS NOT NULL
      ORDER BY "sendAfter" ASC LIMIT ${options.limit ?? SWEEP_BATCH} FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `)
  result.claimed = claimed.length
  if (claimed.length === 0) return result
  if (await isKilled(db, 'notification_delivery')) {
    log.warn('notification delivery is paused by its kill switch', { held: claimed.length })
    return result
  }
  const rows = await db.notificationDelivery.findMany({ where: { id: { in: claimed.map((row) => row.id) } }, include: { notification: true }, orderBy: { createdAt: 'asc' } })
  const contexts = new Map<string, UserContext | null>()
  const groups = new Map<string, typeof rows>()
  for (const row of rows) groups.set(`${row.userId}:${row.channel}`, [...(groups.get(`${row.userId}:${row.channel}`) ?? []), row])

  for (const group of groups.values()) {
    try {
      await releaseGroup(db, deps, contexts, group, now, result)
    } catch (error) {
      result.failed += group.length
      log.error('could not release held deliveries', { error, userId: group[0].userId })
    }
  }
  log.info('held deliveries released', { ...result })
  return result
}

async function releaseGroup(db: PrismaClient, deps: DispatchDeps, contexts: Map<string, UserContext | null>, group: (NotificationDelivery & { notification: Notification | null })[], now: Date, result: ReleaseResult) {
  const userId = group[0].userId
  const channel = group[0].channel
  if (!contexts.has(userId)) contexts.set(userId, await loadContext(db, userId, now))
  const ctx = contexts.get(userId)
  if (!ctx) {
    await db.notificationDelivery.updateMany({ where: { id: { in: group.map((row) => row.id) } }, data: { status: 'SKIPPED', reason: 'NO_DESTINATION', sendAfter: null } })
    result.skipped += group.length
    return
  }

  // Judge each as it stands now.
  const sendable: typeof group = []
  for (const row of group) {
    const kind = isDeliveryKind(row.kind) ? row.kind : null
    if (!kind || !row.notification) {
      await db.notificationDelivery.update({ where: { id: row.id }, data: { status: 'SKIPPED', reason: 'STALE', sendAfter: null } })
      result.skipped += 1
      continue
    }
    const decision = decideDelivery(factsFor(ctx, kind, channel, now, { duplicate: false, createdAt: row.notification.createdAt }))
    if (decision.action === 'SEND') sendable.push(row)
    else if (decision.action === 'DEFER') {
      await db.notificationDelivery.update({ where: { id: row.id }, data: { sendAfter: decision.until, reason: decision.reason } })
      result.deferred += 1
    } else {
      await db.notificationDelivery.update({ where: { id: row.id }, data: { status: 'SKIPPED', reason: decision.reason, sendAfter: null } })
      result.skipped += 1
    }
  }
  if (sendable.length === 0) return

  const ordinary = sendable.filter((row) => POLICY[row.kind as DeliveryKind].class !== 'SECURITY')
  if (ordinary.length > RELEASE_INDIVIDUALLY) {
    // One line for the pile; the account notices among them still go on their own.
    const [lead, ...rest] = ordinary
    const sent = await sendSummary(db, deps, ctx, lead, ordinary.length, now)
    if (sent === 'SENT') result.sent += 1
    else if (sent === 'RETRY') result.deferred += 1
    else result.failed += 1
    if (sent !== 'RETRY') {
      await db.notificationDelivery.updateMany({ where: { id: { in: rest.map((row) => row.id) } }, data: { status: 'SKIPPED', reason: 'SUMMARISED', sendAfter: null } })
      result.summarised += rest.length
    } else {
      result.deferred += rest.length
    }
    for (const row of sendable.filter((candidate) => !ordinary.includes(candidate))) await sendHeld(db, deps, ctx, row, now, result)
    return
  }
  for (const row of sendable) await sendHeld(db, deps, ctx, row, now, result)
}

async function sendHeld(db: PrismaClient, deps: DispatchDeps, ctx: UserContext, row: NotificationDelivery & { notification: Notification | null }, now: Date, result: ReleaseResult) {
  if (!row.notification) return
  const outcome = await transmit(db, deps, ctx, row, row.notification, row.kind as DeliveryKind, now)
  if (outcome === 'SENT') result.sent += 1
  else if (outcome === 'RETRY') result.deferred += 1
  else result.failed += 1
}

/** One delivery that stands for a pile: "You have 5 new notifications", with nothing of what they say. */
async function sendSummary(db: PrismaClient, deps: DispatchDeps, ctx: UserContext, lead: NotificationDelivery, count: number, now: Date): Promise<SendOutcome> {
  const kind = lead.kind as DeliveryKind
  const visible = { title: `You have ${count} new notifications`, body: t(ctx.locale, 'neutral.body') }
  const path = '/notifications'
  if (lead.channel === 'EMAIL') {
    if (!ctx.email) return 'FAILED'
    const rendered = renderNotificationEmail({ locale: ctx.locale, name: ctx.name, visible, url: openUrl(deps, lead.id, path), footer: footerFor(deps, ctx.id, kind), neutral: true })
    return sendEmailFor(db, deps, lead, ctx.email, rendered, unsubscribeHeaders(deps, ctx.id, kind), now, kind)
  }
  return sendPushFor(db, deps, lead, ctx.subscriptions, renderPush(visible, path, 'summary'), 'low', now, kind)
}

// --- The job ---------------------------------------------------------------------------------------------------------------

export async function runDeliveryJob(): Promise<{ sweep: SweepResult; release: ReleaseResult }> {
  const { prisma } = await import('@/lib/prisma')
  const deps = defaultDeps()
  const release = await releaseDeferred(prisma, deps)
  const sweep = await sweepNotifications(prisma, deps)
  return { sweep, release }
}
