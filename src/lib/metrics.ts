import type { Prisma, PrismaClient } from '@prisma/client'
import type { DomainEventName, DomainEvents, Db } from '@/lib/events'
import { advisoryLock } from '@/lib/progress'
import { utcTimestamp } from '@/lib/sql'

// What the platform counts for each user. A metric is a named count of one kind of thing a
// person did ("projects shipped"); achievements unlock when a metric reaches a number and quests
// ask for a number of one inside a day or a week. Only the rewards pipeline writes them: an event
// is turned into ticks (EVENT_TICKS), and recordTick() counts each tick exactly once.
//
// A tick is only produced for an award that really paid XP, so a metric can never move faster than the
// daily caps allow and a repeated event (a retry, endorsing again after withdrawing) counts once.

export const METRICS = [
  'projects_created',
  'ships',
  'milestones',
  'updates',
  'evidence_added',
  'endorsements_given',
  'endorsements_received',
  'hackathons_joined',
  'hackathon_wins',
  'crews_formed',
  'teams_joined',
  'connections',
  'first_messages',
  'replies',
] as const
export type Metric = (typeof METRICS)[number]

export interface Tick {
  userId: string
  metric: Metric
  /** Identifies the thing counted, so counting it again does nothing. */
  dedupeKey: string
}

type TickRule<N extends DomainEventName> = (payload: DomainEvents[N], paid: ReadonlySet<string>) => Tick[]

const own =
  <N extends DomainEventName>(metric: Metric, key: (payload: DomainEvents[N]) => string): TickRule<N> =>
  (payload, paid) => {
    const { userId } = payload as unknown as { userId: string }
    return paid.has(userId) ? [{ userId, metric, dedupeKey: key(payload) }] : []
  }

/**
 * What each event counts, given who was paid for it (`paid`: the people whose XP award for the event
 * went through). Events that pay nothing of their own (a reply) count without that check.
 */
export const EVENT_TICKS: { [N in DomainEventName]?: TickRule<N> } = {
  PROJECT_CREATED: own('projects_created', (p) => p.projectId),
  PROJECT_SHIPPED: own('ships', (p) => p.projectId),
  PROJECT_UPDATE_POSTED: own('updates', (p) => p.updateId),
  MILESTONE_COMPLETED: own('milestones', (p) => p.milestoneId),
  HACKATHON_JOINED: own('hackathons_joined', (p) => p.hackathonId),
  HACKATHON_WON: own('hackathon_wins', (p) => p.hackathonId),
  TEAM_FORMED: own('crews_formed', (p) => p.hackathonId),
  TEAM_APPLICATION_ACCEPTED: own('teams_joined', (p) => p.applicationId),
  EVIDENCE_ADDED: own('evidence_added', (p) => p.evidenceId),
  // The owner is paid and counts it received; the endorser counts it given, but only once the owner's award went through.
  EVIDENCE_ENDORSED: (p, paid) => {
    if (!paid.has(p.userId)) return []
    const dedupeKey = `${p.evidenceId}:${p.endorserId}`
    return [
      { userId: p.userId, metric: 'endorsements_received', dedupeKey },
      { userId: p.endorserId, metric: 'endorsements_given', dedupeKey },
    ]
  },
  CONNECTION_ACCEPTED: (p, paid) =>
    [p.userId, p.otherUserId].filter((id) => paid.has(id)).map((userId) => ({ userId, metric: 'connections' as const, dedupeKey: p.connectionId })),
  MESSAGE_SENT_FIRST_IN_CONNECTION: own('first_messages', (p) => p.conversationId),
  // Replying pays no XP of its own, so it counts without being paid.
  MESSAGE_REPLIED: (p) => [{ userId: p.userId, metric: 'replies', dedupeKey: p.messageId }],
}

export function ticksFor<N extends DomainEventName>(name: N, payload: DomainEvents[N], paid: ReadonlySet<string>): Tick[] {
  const rule = EVENT_TICKS[name] as TickRule<N> | undefined
  return rule ? rule(payload, paid) : []
}

type Tx = Prisma.TransactionClient

const locked = new WeakMap<object, Set<string>>()

/**
 * Serialises the progress of users inside one transaction (and across transactions). The locks are
 * taken in sorted order and only once per transaction, and an event takes all of them before it writes
 * to any user row, so two requests that involve the same people cannot wait on each other.
 */
export async function lockProgress(db: Db, userIds: readonly string[]) {
  const tx = db as Tx
  let held = locked.get(tx)
  if (!held) locked.set(tx, (held = new Set()))
  for (const userId of [...new Set(userIds)].sort()) {
    if (held.has(userId)) continue
    await advisoryLock(tx, `progress:${userId}`)
    held.add(userId)
  }
}

/**
 * Counts a tick once. Returns the metric's new total for the user, or null when this tick was already
 * counted (and so changes nothing, for achievements and quests alike).
 */
export async function recordTick(db: Db, tick: Tick, now: Date = new Date()): Promise<number | null> {
  const tx = db as Tx
  await lockProgress(tx, [tick.userId])
  const inserted = await tx.progressTick.createMany({
    data: [{ userId: tick.userId, metric: tick.metric, dedupeKey: tick.dedupeKey, createdAt: now }],
    skipDuplicates: true,
  })
  if (inserted.count === 0) return null
  const [row] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "UserCounter" ("id", "userId", "key", "value", "updatedAt")
    VALUES (gen_random_uuid()::text, ${tick.userId}, ${tick.metric}, 1, ${utcTimestamp(now)})
    ON CONFLICT ("userId", "key") DO UPDATE SET "value" = "UserCounter"."value" + 1, "updatedAt" = ${utcTimestamp(now)}
    RETURNING "value"
  `
  return row.value
}

/** All of a user's counters, as a plain lookup. */
export async function readCounters(db: Pick<PrismaClient, 'userCounter'>, userId: string): Promise<Record<string, number>> {
  const rows = await db.userCounter.findMany({ where: { userId }, select: { key: true, value: true } })
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}
