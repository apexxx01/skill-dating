import type { DomainEventName, DomainEvents, Db } from '@/lib/events'
import { achievementSeries, type AchievementSlug } from '@/lib/achievement-definitions'
import { grantAchievement } from '@/lib/achievements'
import { levelFor, TIER_START_LEVEL } from '@/lib/levels'
import { lockProgress, recordTick, ticksFor, type Metric } from '@/lib/metrics'
import { advanceQuests } from '@/lib/quest-progress'
import { isLocalWeekend, localHour, localWeekStart } from '@/lib/time'

// The progress engine: turns a domain event into counted ticks (src/lib/metrics.ts) and unlocks the
// achievements those counts reach. It runs inside the transaction of the action that caused the event,
// right after the rewards engine has paid for it, and every unlock goes through grantAchievement(), so
// its XP is an ordinary grant() and shows up in the request's rewards envelope.
//
// An achievement is never granted from anywhere else. "Ad hoc" grants from routes do not exist: a route
// emits an event, this module counts it, and the definition file says what the count unlocks.

/** Hours of the night, local time, that count for the Night Owl: 02:00 up to but not including 05:00. */
const NIGHT_OWL_HOURS = { from: 2, until: 5 }
/** Ships in one local week for the Hat Trick. */
const HAT_TRICK_SHIPS = 3
/** The streak, in days, that No Safety Net asks for without a freeze. */
const CLEAN_RUN_DAYS = 30
/** An endorser at this level or above (Gold) makes the Golden Vouch. */
const GOLDEN_VOUCH_LEVEL = TIER_START_LEVEL.GOLD

/** Unlocks every achievement of a series whose target the value has reached and the user does not have yet. */
export async function unlockSeries(tx: Db, userId: string, metric: Metric | 'streak_days', value: number): Promise<number> {
  const reached = achievementSeries(metric).filter((entry) => entry.target <= value)
  if (reached.length === 0) return 0

  const have = await tx.userAchievement.findMany({
    where: { userId, achievement: { slug: { in: reached.map((entry) => entry.slug) } } },
    select: { achievement: { select: { slug: true } } },
  })
  const owned = new Set(have.map((row) => row.achievement.slug))

  let unlocked = 0
  for (const entry of reached) {
    if (owned.has(entry.slug)) continue
    if ((await grantAchievement(tx, userId, entry.slug, { current: value, target: entry.target })).granted) unlocked += 1
  }
  return unlocked
}

async function grantSecret(tx: Db, userId: string, slug: AchievementSlug): Promise<number> {
  return (await grantAchievement(tx, userId, slug)).granted ? 1 : 0
}

async function timezoneOf(tx: Db, userId: string): Promise<string | null> {
  return (await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } }))?.timezone ?? null
}

/**
 * The secret achievements that a shipped project can unlock: a ship in the small hours, three in a
 * week, and a weekend ship after a weekday one. `now` is when the project shipped; the tick for it
 * has just been counted, so it is among the week's ships.
 */
export async function unlockShipSecrets(tx: Db, userId: string, now: Date): Promise<number> {
  const timezone = await timezoneOf(tx, userId)
  let unlocked = 0

  const hour = localHour(now, timezone)
  if (hour >= NIGHT_OWL_HOURS.from && hour < NIGHT_OWL_HOURS.until) unlocked += await grantSecret(tx, userId, 'night-owl')

  const weekStart = localWeekStart(now, timezone)
  const thisWeek = await tx.progressTick.findMany({
    where: { userId, metric: 'ships', createdAt: { gte: weekStart } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  if (thisWeek.length >= HAT_TRICK_SHIPS) unlocked += await grantSecret(tx, userId, 'hat-trick')

  if (isLocalWeekend(now, timezone)) {
    // The week runs Monday to Sunday, so any earlier ship in it that was not on a weekend was on a weekday.
    const earlierOnAWeekday = thisWeek.some((tick) => tick.createdAt.getTime() < now.getTime() && !isLocalWeekend(tick.createdAt, timezone))
    if (earlierOnAWeekday) unlocked += await grantSecret(tx, userId, 'weekend-warrior')
  }
  return unlocked
}

/** Golden Vouch: the first endorsement the owner receives from somebody at Gold or above. */
export async function unlockGoldenVouch(tx: Db, ownerId: string, endorserId: string): Promise<number> {
  const endorser = await tx.user.findUnique({ where: { id: endorserId }, select: { xp: true } })
  if (!endorser || levelFor(endorser.xp).level < GOLDEN_VOUCH_LEVEL) return 0
  return grantSecret(tx, ownerId, 'golden-vouch')
}

/** The streak grew: the streak series, and No Safety Net when the run is 30 days without a freeze. */
export async function unlockStreak(tx: Db, userId: string, current: number, freezeUsedInRun: boolean): Promise<number> {
  let unlocked = await unlockSeries(tx, userId, 'streak_days', current)
  if (current >= CLEAN_RUN_DAYS && !freezeUsedInRun) unlocked += await grantSecret(tx, userId, 'no-safety-net')
  return unlocked
}

/** The people an event touches, whose progress must be locked before any of them is written. */
export function usersInvolved(name: DomainEventName, payload: DomainEvents[DomainEventName]): string[] {
  const { userId, endorserId, otherUserId, giverId } = payload as { userId: string; endorserId?: string; otherUserId?: string; giverId?: string }
  return [userId, endorserId, otherUserId, giverId].filter((id): id is string => typeof id === 'string')
}

/**
 * Counts what an event is worth to progress and unlocks what that reaches. `paid` is the set of people
 * whose XP award for the event went through. Returns how many achievements this unlocked.
 */
export async function advanceProgress<N extends DomainEventName>(
  tx: Db,
  name: N,
  payload: DomainEvents[N],
  paid: ReadonlySet<string>,
  now: Date = new Date()
): Promise<{ unlocked: number }> {
  let unlocked = 0

  // Sorted, so two requests touching the same people count in the same order.
  const ticks = ticksFor(name, payload, paid).sort((a, b) => (a.userId === b.userId ? a.metric.localeCompare(b.metric) : a.userId.localeCompare(b.userId)))
  for (const tick of ticks) {
    const value = await recordTick(tx, tick, now)
    if (value === null) continue
    unlocked += await unlockSeries(tx, tick.userId, tick.metric, value)
    // The same count moves the quests the user has right now.
    await advanceQuests(tx, tick.userId, tick.metric, now, await timezoneOf(tx, tick.userId))
    if (tick.metric === 'ships') unlocked += await unlockShipSecrets(tx, tick.userId, now)
    if (tick.metric === 'endorsements_received') {
      unlocked += await unlockGoldenVouch(tx, tick.userId, (payload as DomainEvents['EVIDENCE_ENDORSED']).endorserId)
    }
  }

  if (name === 'STREAK_EXTENDED') {
    const streak = payload as DomainEvents['STREAK_EXTENDED']
    await lockProgress(tx, [streak.userId])
    unlocked += await unlockStreak(tx, streak.userId, streak.current, streak.freezeUsedInRun)
  }
  if (name === 'USER_COMEBACK') {
    const comeback = payload as DomainEvents['USER_COMEBACK']
    await lockProgress(tx, [comeback.userId])
    unlocked += await grantSecret(tx, comeback.userId, 'comeback-kid')
  }

  return { unlocked }
}
