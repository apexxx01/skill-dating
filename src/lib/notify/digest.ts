import { Prisma, type PrismaClient } from '@prisma/client'
import { blockedPeerIds } from '@/lib/blocks'
import { loadHeatmap, heatmapRange } from '@/lib/heatmap'
import { log } from '@/lib/log'
import { readLeaderboard } from '@/lib/leaderboard-read'
import { isKilled } from '@/lib/ops/kill-switches'
import { loadQuests } from '@/lib/quest-view'
import { readUserStreak } from '@/lib/streak-status'
import { utcTimestamp } from '@/lib/sql'
import { isoWeekdayOfDateKey, localDateKey, localTimeKey, localWeekKey } from '@/lib/time'
import { defaultDeps, footerFor, loadContext, openUrl, sendEmailFor, unsubscribeHeaders, type DispatchDeps, type UserContext } from './dispatch'
import { inQuietHours } from './quiet'
import { tn, t, type Locale } from './strings'
import { renderDigestEmail, type DigestSection } from './templates'

// The digests: the email the platform starts on its own, to bring a person back to what is waiting for them.
//
//   daily    once a local day, an hour after the person's drop time (09:00 unless they chose another): today's Drops, how many people sparked them (a count, never
//            names), squad deadlines (registration closing with no squad, a submission due), and, only beside one of those, how many daily quests are open.
//   weekly   Monday from 09:00 local: the Ship Day recap, the person's streak and the last 7 days, their season standing.
//
// Each is account mail (ACTIVITY in policy.ts), on by default: it needs the person's digest switch, a verified address that has not bounced, and a person who was
// here in the last 60 days; every one carries a one-click unsubscribe for the kind and for all mail. It is skipped when there is nothing worth saying, and the run says so instead of mailing "a quiet week". Nothing here reads romance data.

export const DAILY_DIGEST_DEFAULT_DROP_TIME = '09:00'
export const DAILY_DIGEST_LAST_HOUR = '20:00'
export const WEEKLY_DIGEST_FROM = '09:00'
export const WEEKLY_DIGEST_WEEKDAY = 1
export const DORMANT_AFTER_DAYS = 60
/** Sparks from before the last digest are not counted by a first digest older than this. */
const SPARK_LOOKBACK_MS = 48 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Where the digest's links go (paths in the app). One table, so the frontend can say where these screens are. */
export const DIGEST_LINKS = {
  drops: '/discover',
  sparks: '/sparks',
  hackathon: (id: string) => `/hackathons/${id}`,
  quests: '/dashboard',
  shipDay: '/dashboard',
  activity: '/dashboard',
  leaderboard: '/dashboard',
} as const

// --- Daily ---------------------------------------------------------------------------------------------------------------

export interface DailyFacts {
  drops: number
  sparks: number
  registrationClosing: { id: string; name: string; at: Date }[]
  submissionsDue: { id: string; name: string; at: Date }[]
  openDailyQuests: number
  /** When the weekly quests reset, if that is within a day and a half and some are open. */
  weeklyQuestsEndAt: Date | null
}

export interface DigestContent {
  subject: string
  intro: string
  sections: DigestSection[]
}

/** "in 2 days", "in 5 hours", for a moment that is ahead. */
export function relativeWhen(now: Date, at: Date, locale: Locale): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const hours = Math.max(Math.round((at.getTime() - now.getTime()) / HOUR_MS), 1)
  return hours >= 36 ? format.format(Math.round(hours / 24), 'day') : format.format(hours, 'hour')
}

/**
 * The daily digest as the facts make it, or null when there is nothing worth sending. What makes it worth sending: Drops waiting, people who sparked, a squad
 * deadline. The quest lines only ever come beside one of those.
 */
export function assembleDaily(facts: DailyFacts, baseUrl: string, now: Date, locale: Locale): DigestContent | null {
  const url = (path: string) => `${baseUrl}${path}`
  const today: DigestSection = { heading: t(locale, 'digest.section.today'), items: [] }
  const squads: DigestSection = { heading: t(locale, 'digest.section.squads'), items: [] }
  const quests: DigestSection = { heading: t(locale, 'digest.section.quests'), items: [] }
  let worth = 0

  if (facts.drops > 0) {
    today.items.push({ text: tn(locale, 'digest.daily.drops', facts.drops), url: url(DIGEST_LINKS.drops), cta: t(locale, 'digest.daily.drops.cta') })
    worth += 1
  }
  if (facts.sparks > 0) {
    today.items.push({ text: tn(locale, 'digest.daily.sparks', facts.sparks), url: url(DIGEST_LINKS.sparks), cta: t(locale, 'digest.daily.sparks.cta') })
    worth += 1
  }
  for (const hackathon of facts.registrationClosing) {
    squads.items.push({ text: t(locale, 'digest.daily.registrationCloses', { name: hackathon.name, when: relativeWhen(now, hackathon.at, locale) }), url: url(DIGEST_LINKS.hackathon(hackathon.id)), cta: t(locale, 'digest.daily.squad.cta') })
    worth += 1
  }
  for (const hackathon of facts.submissionsDue) {
    squads.items.push({ text: t(locale, 'digest.daily.submissionDue', { name: hackathon.name, when: relativeWhen(now, hackathon.at, locale) }), url: url(DIGEST_LINKS.hackathon(hackathon.id)), cta: t(locale, 'digest.daily.squad.cta') })
    worth += 1
  }
  if (worth === 0) return null

  if (facts.openDailyQuests > 0) quests.items.push({ text: tn(locale, 'digest.daily.quests', facts.openDailyQuests), url: url(DIGEST_LINKS.quests), cta: t(locale, 'digest.daily.quests.cta') })
  if (facts.weeklyQuestsEndAt) quests.items.push({ text: t(locale, 'digest.daily.weeklyQuestEnds', { when: relativeWhen(now, facts.weeklyQuestsEndAt, locale) }), url: url(DIGEST_LINKS.quests), cta: t(locale, 'digest.daily.quests.cta') })

  return { subject: tn(locale, 'digest.daily.subject', worth), intro: t(locale, 'digest.daily.intro'), sections: [today, squads, quests].filter((section) => section.items.length > 0) }
}

export async function gatherDailyFacts(db: PrismaClient, ctx: UserContext, now: Date, lastDigestAt: Date | null): Promise<DailyFacts> {
  const today = localDateKey(now, ctx.timezone)
  const hidden = await blockedPeerIds(db, ctx.id)
  const sparksSince = lastDigestAt ?? new Date(now.getTime() - SPARK_LOOKBACK_MS)

  const [drops, sparks, registering, submitting, quests] = await Promise.all([
    db.drop.count({ where: { userId: ctx.id, localDate: today, status: 'NEW', expiresAt: { gt: now } } }),
    // The professional sparks only: the romance mode's are never counted, named or hinted at outside the app.
    db.spark.count({
      where: { toId: ctx.id, status: 'PENDING', connectionType: { not: 'DATING' }, moderatedAt: null, createdAt: { gt: sparksSince }, from: { deletedAt: null, ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}) } },
    }),
    db.hackathonParticipant.findMany({
      where: { userId: ctx.id, teamId: null, status: 'REGISTERED', hackathon: { isPublic: true, status: { in: ['UPCOMING', 'ACTIVE'] }, OR: [{ registrationDeadline: { gt: now, lte: new Date(now.getTime() + 3 * DAY_MS) } }, { registrationDeadline: null, startDate: { gt: now, lte: new Date(now.getTime() + 3 * DAY_MS) } }] } },
      select: { hackathon: { select: { id: true, name: true, registrationDeadline: true, startDate: true } } },
      take: 3,
    }),
    db.hackathonParticipant.findMany({
      where: { userId: ctx.id, teamId: { not: null }, status: 'TEAM_FORMED', hackathon: { status: 'ACTIVE', OR: [{ submissionDeadline: { gt: now, lte: new Date(now.getTime() + 2 * DAY_MS) } }, { submissionDeadline: null, endDate: { gt: now, lte: new Date(now.getTime() + 2 * DAY_MS) } }] } },
      select: { hackathon: { select: { id: true, name: true, submissionDeadline: true, endDate: true } } },
      take: 3,
    }),
    loadQuests(db, ctx.id, ctx.timezone, now),
  ])

  const openDaily = quests.enabled ? quests.daily.quests.filter((quest) => !quest.completed).length : 0
  const weeklyEnds = new Date(quests.weekly.resetsAt)
  const weeklyOpen = quests.enabled && quests.weekly.quests.some((quest) => !quest.completed)
  return {
    drops,
    sparks,
    registrationClosing: registering.map((row) => ({ id: row.hackathon.id, name: row.hackathon.name, at: row.hackathon.registrationDeadline ?? row.hackathon.startDate })),
    submissionsDue: submitting.map((row) => ({ id: row.hackathon.id, name: row.hackathon.name, at: row.hackathon.submissionDeadline ?? row.hackathon.endDate })),
    openDailyQuests: openDaily,
    weeklyQuestsEndAt: weeklyOpen && weeklyEnds.getTime() - now.getTime() <= 36 * HOUR_MS ? weeklyEnds : null,
  }
}

// --- Weekly --------------------------------------------------------------------------------------------------------------

export interface WeeklyFacts {
  shipDay: { total: number; yourPosts: number; yourProps: number; topTitle: string | null } | null
  streak: { current: number; activeDays: number }
  season: { name: string; rank: number; score: number } | null
}

export function assembleWeekly(facts: WeeklyFacts, baseUrl: string, locale: Locale): DigestContent | null {
  const url = (path: string) => `${baseUrl}${path}`
  const sections: DigestSection[] = []
  let worth = false

  if (facts.shipDay && facts.shipDay.total > 0) {
    const items: DigestSection['items'] = [{ text: tn(locale, 'digest.weekly.shipDay.total', facts.shipDay.total), url: url(DIGEST_LINKS.shipDay), cta: t(locale, 'digest.weekly.shipDay.cta') }]
    if (facts.shipDay.yourPosts > 0) {
      items.unshift({ text: tn(locale, 'digest.weekly.shipDay.yours', facts.shipDay.yourPosts, { props: facts.shipDay.yourProps }) })
      worth = true
    }
    if (facts.shipDay.topTitle) items.push({ text: t(locale, 'digest.weekly.shipDay.top', { title: facts.shipDay.topTitle }) })
    sections.push({ heading: t(locale, 'digest.weekly.section.shipDay'), items })
  }
  if (facts.streak.current > 0 || facts.streak.activeDays > 0) {
    const items: DigestSection['items'] = []
    if (facts.streak.current > 0) items.push({ text: tn(locale, 'digest.weekly.streak.current', facts.streak.current) })
    items.push({ text: t(locale, 'digest.weekly.streak.active', { active: facts.streak.activeDays }), url: url(DIGEST_LINKS.activity), cta: t(locale, 'digest.weekly.streak.cta') })
    sections.push({ heading: t(locale, 'digest.weekly.section.streak'), items })
    worth = true
  }
  if (facts.season) {
    sections.push({
      heading: t(locale, 'digest.weekly.section.season'),
      items: [{ text: t(locale, 'digest.weekly.season.standing', { rank: facts.season.rank, season: facts.season.name, score: facts.season.score }), url: url(DIGEST_LINKS.leaderboard), cta: t(locale, 'digest.weekly.season.cta') }],
    })
    worth = true
  }
  // A recap of other people's week, with nothing of the reader's in it, is not worth an email.
  if (!worth) return null
  return { subject: t(locale, 'digest.weekly.subject'), intro: t(locale, 'digest.weekly.intro'), sections }
}

export async function gatherWeeklyFacts(db: PrismaClient, ctx: UserContext, now: Date): Promise<WeeklyFacts> {
  const recap = await db.shipDayRecap.findFirst({ where: { createdAt: { gte: new Date(now.getTime() - 5 * DAY_MS) } }, orderBy: { createdAt: 'desc' } })
  let shipDay: WeeklyFacts['shipDay'] = null
  if (recap) {
    const mine = await db.shipPost.aggregate({ where: { authorId: ctx.id, shipDayKey: recap.dateKey, deletedAt: null, moderatedAt: null }, _count: { _all: true }, _sum: { propsCount: true } })
    const top = Array.isArray(recap.topPosts) ? (recap.topPosts as { title?: unknown }[])[0] : undefined
    shipDay = { total: recap.totalPosts, yourPosts: mine._count._all, yourProps: mine._sum.propsCount ?? 0, topTitle: typeof top?.title === 'string' ? top.title : null }
  }
  const [streak, days, board] = await Promise.all([
    readUserStreak(db, ctx.id, now),
    loadHeatmap(db, ctx.id, heatmapRange(7, ctx.timezone, now)),
    readLeaderboard(db, { viewerId: ctx.id, period: 'season', scope: 'global', scopeId: null, cursor: undefined, page: 1, limit: 1, blocked: [], now }),
  ])
  const season = board.kind === 'ok' && board.data.season && board.data.me.rank !== null ? { name: board.data.season.name, rank: board.data.me.rank, score: board.data.me.score } : null
  return { shipDay, streak: { current: streak?.current ?? 0, activeDays: days.filter((day) => day.actions > 0).length }, season }
}

// --- Sending -------------------------------------------------------------------------------------------------------------

export type DigestKind = 'DIGEST_DAILY' | 'DIGEST_WEEKLY'

export type DigestOutcome = 'SENT' | 'NOTHING_TO_SEND' | 'NOT_DUE' | 'NOT_ELIGIBLE' | 'FAILED'

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))

/** Whether this person's local moment is the time to send a digest of this kind. Pure. */
export function digestDue(kind: DigestKind, now: Date, timezone: string | null, dropTime: string, lastSentAt: Date | null, quiet: Parameters<typeof inQuietHours>[2]): boolean {
  const clock = localTimeKey(now, timezone)
  if (inQuietHours(now, timezone, quiet)) return false
  if (clock >= DAILY_DIGEST_LAST_HOUR) return false
  if (kind === 'DIGEST_DAILY') {
    const from = Math.min(minutesOf(dropTime) + 60, minutesOf(DAILY_DIGEST_LAST_HOUR) - 60)
    if (minutesOf(clock) < from) return false
    return !lastSentAt || localDateKey(lastSentAt, timezone) !== localDateKey(now, timezone)
  }
  if (isoWeekdayOfDateKey(localDateKey(now, timezone)) !== WEEKLY_DIGEST_WEEKDAY || clock < WEEKLY_DIGEST_FROM) return false
  return !lastSentAt || localWeekKey(lastSentAt, timezone) !== localWeekKey(now, timezone)
}

/** The digest for one person if it is due and worth sending, and its record. Never throws for one person's trouble. */
export async function sendDigest(db: PrismaClient, deps: DispatchDeps, kind: DigestKind, userId: string, now: Date): Promise<DigestOutcome> {
  const ctx = await loadContext(db, userId, now)
  if (!ctx || !ctx.email || ctx.suppressed) return 'NOT_ELIGIBLE'
  const wanted = kind === 'DIGEST_DAILY' ? ctx.settings.dailyDigest : ctx.settings.weeklyDigest
  if (!ctx.settings.emailEnabled || !wanted) return 'NOT_ELIGIBLE'
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { lastActiveAt: true, matchingProfile: { select: { dropTimeLocal: true } }, notifSettings: { select: { lastDailyDigestAt: true, lastWeeklyDigestAt: true } } },
  })
  if (!row || now.getTime() - row.lastActiveAt.getTime() > DORMANT_AFTER_DAYS * DAY_MS) return 'NOT_ELIGIBLE'
  const lastSentAt = (kind === 'DIGEST_DAILY' ? row.notifSettings?.lastDailyDigestAt : row.notifSettings?.lastWeeklyDigestAt) ?? null
  if (!digestDue(kind, now, ctx.timezone, row.matchingProfile?.dropTimeLocal ?? DAILY_DIGEST_DEFAULT_DROP_TIME, lastSentAt, ctx.settings)) return 'NOT_DUE'

  const content = kind === 'DIGEST_DAILY' ? assembleDaily(await gatherDailyFacts(db, ctx, now, lastSentAt), deps.baseUrl, now, ctx.locale) : assembleWeekly(await gatherWeeklyFacts(db, ctx, now), deps.baseUrl, ctx.locale)
  // Nothing worth saying today: checked again at the next run, and the day is not used up.
  if (!content) return 'NOTHING_TO_SEND'

  const period = kind === 'DIGEST_DAILY' ? localDateKey(now, ctx.timezone) : localWeekKey(now, ctx.timezone)
  let delivery
  try {
    delivery = await db.notificationDelivery.create({ data: { userId, kind, channel: 'EMAIL', status: 'DEFERRED', reason: 'SENDING', dedupeKey: `digest:${period}`, sendAfter: new Date(now.getTime() + 15 * 60_000) } })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'NOT_DUE'
    throw error
  }
  const rendered = renderDigestEmail({
    locale: ctx.locale,
    name: ctx.name,
    subject: content.subject,
    intro: content.intro,
    sections: content.sections.map((section) => ({
      ...section,
      // Every link goes through the click-through, so the digest's open rate is measured like any other email's.
      items: section.items.map((item) => (item.url ? { ...item, url: openUrl(deps, delivery.id, item.url.slice(deps.baseUrl.length)) } : item)),
    })),
    footer: { ...footerFor(deps, ctx.id, kind, ctx.locale), kindLabel: t(ctx.locale, kind === 'DIGEST_DAILY' ? 'digest.daily.name' : 'digest.weekly.name') },
  })
  const outcome = await sendEmailFor(db, deps, delivery, ctx.email, rendered, unsubscribeHeaders(deps, ctx.id, kind), now, kind)
  if (outcome === 'SENT') {
    await db.notificationSettings.upsert({
      where: { userId },
      create: { userId, ...(kind === 'DIGEST_DAILY' ? { lastDailyDigestAt: now } : { lastWeeklyDigestAt: now }) },
      update: kind === 'DIGEST_DAILY' ? { lastDailyDigestAt: now } : { lastWeeklyDigestAt: now },
    })
    return 'SENT'
  }
  // A refused digest is not tried again (the row stays FAILED, the period's key is taken); one the provider was too busy for is left to the next run.
  if (outcome === 'RETRY') await db.notificationDelivery.delete({ where: { id: delivery.id } })
  return 'FAILED'
}

// --- The job -------------------------------------------------------------------------------------------------------------

export interface DigestRunResult {
  considered: number
  sent: number
  nothingToSend: number
  notDue: number
  notEligible: number
  failed: number
  /** The id to continue from, when there are more people than one run takes. */
  next: string | null
}

const DIGEST_BATCH = 500

/** People with a verified address who are not dormant or deleted, after `after`: the only people a digest can go to. */
async function candidates(db: PrismaClient, now: Date, after: string | undefined): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u."id" FROM "User" u
    WHERE u."deletedAt" IS NULL AND u."isEmailVerified" = true
      AND u."lastActiveAt" >= ${utcTimestamp(new Date(now.getTime() - DORMANT_AFTER_DAYS * DAY_MS))}
      AND ${after ?? ''} < u."id"
    ORDER BY u."id" ASC LIMIT ${DIGEST_BATCH}
  `)
  return rows.map((row) => row.id)
}

export async function runDigests(db: PrismaClient, kind: DigestKind, options: { now?: Date; after?: string; deps?: DispatchDeps } = {}): Promise<DigestRunResult> {
  const now = options.now ?? new Date()
  const deps = { ...(options.deps ?? defaultDeps()), now }
  const result: DigestRunResult = { considered: 0, sent: 0, nothingToSend: 0, notDue: 0, notEligible: 0, failed: 0, next: null }
  if (await isKilled(db, 'notification_delivery')) return result
  const ids = await candidates(db, now, options.after)
  result.considered = ids.length
  for (const id of ids) {
    try {
      const outcome = await sendDigest(db, deps, kind, id, now)
      if (outcome === 'SENT') result.sent += 1
      else if (outcome === 'NOTHING_TO_SEND') result.nothingToSend += 1
      else if (outcome === 'NOT_DUE') result.notDue += 1
      else if (outcome === 'NOT_ELIGIBLE') result.notEligible += 1
      else result.failed += 1
    } catch (error) {
      result.failed += 1
      log.error('could not send a digest', { error, userId: id, kind })
    }
  }
  if (ids.length === DIGEST_BATCH) result.next = ids[ids.length - 1]
  log.info('digest run', { kind, ...result })
  return result
}

export async function runDigestJob(kind: DigestKind, data: { after?: string }): Promise<DigestRunResult> {
  const { prisma } = await import('@/lib/prisma')
  const result = await runDigests(prisma, kind, { after: data.after })
  // A big population is taken in batches, each continuing the last.
  if (result.next) {
    const { getJobQueue } = await import('@/lib/infra/jobs')
    await getJobQueue().enqueue(kind === 'DIGEST_DAILY' ? 'digests/daily' : 'digests/weekly', { after: result.next })
  }
  return result
}
