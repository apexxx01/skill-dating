import type { PrismaClient } from '@prisma/client'
import type { DropItem, MatchTypeName, TodayDrops } from '@/types/api'
import { blockedPeerIds } from '@/lib/blocks'
import { track } from '@/lib/infra/analytics'
import { utcTimestamp } from '@/lib/sql'
import { addDaysToDateKey, localDateKey, localDateStart } from '@/lib/time'
import { loadPersonSummaries, proofSnapshot } from './summary'

// What the drop routes answer with.

type Db = PrismaClient

/** The instant a "HH:MM" on a calendar day happens in a zone. Off by an hour on the one day a year the clocks change in between, which is fine for a countdown. */
function localInstant(dateKey: string, clock: string, timeZone: string | null): Date {
  const [hours, minutes] = clock.split(':').map(Number)
  return new Date(localDateStart(dateKey, timeZone).getTime() + (hours * 60 + minutes) * 60_000)
}

export async function loadTodayDrops(db: Db, userId: string, now: Date = new Date()): Promise<TodayDrops> {
  const [user, profile] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    db.matchingProfile.findUnique({ where: { userId }, select: { dropTimeLocal: true, paused: true, lastDropDate: true, connectionTypes: true } }),
  ])
  const timezone = user?.timezone ?? null
  const date = localDateKey(now, timezone)
  const base: TodayDrops = {
    date,
    drops: [],
    hasProfile: Boolean(profile && profile.connectionTypes.length > 0),
    paused: profile?.paused ?? false,
    dropTimeLocal: profile?.dropTimeLocal ?? '09:00',
    nextDropAt: null,
  }

  if (profile && !profile.paused && profile.connectionTypes.length > 0) {
    // Today's are made once their time has passed; otherwise the next ones are today at that time, or tomorrow at it.
    const today = localInstant(date, profile.dropTimeLocal, timezone)
    const tomorrow = localInstant(addDaysToDateKey(date, 1), profile.dropTimeLocal, timezone)
    base.nextDropAt = (profile.lastDropDate === date || today.getTime() <= now.getTime() ? tomorrow : today).toISOString()
  }

  const rows = await db.drop.findMany({ where: { userId, localDate: date }, orderBy: [{ score: 'desc' }, { id: 'asc' }] })
  if (rows.length === 0) return base

  const [hidden, people] = await Promise.all([blockedPeerIds(db, userId), loadPersonSummaries(db, rows.map((row) => row.candidateId))])
  const blocked = new Set(hidden)
  const visible = rows.filter((row) => people.has(row.candidateId) && !blocked.has(row.candidateId))

  // First sight of a new drop: stamped once, and counted once even if two requests race (the database says which rows it changed).
  const unseen = visible.filter((row) => row.status === 'NEW' && row.viewedAt === null).map((row) => row.id)
  if (unseen.length > 0) {
    const seen = await db.$queryRaw<{ id: string }[]>`
      UPDATE "Drop" SET "viewedAt" = ${utcTimestamp(now)} WHERE "id" = ANY(${unseen}::text[]) AND "viewedAt" IS NULL RETURNING "id"
    `
    const first = new Set(seen.map((row) => row.id))
    for (const row of visible) {
      if (first.has(row.id)) await track(userId, 'drop_viewed', { dropId: row.id, connectionType: row.connectionType, score: row.score, secondLook: row.secondLook })
    }
  }

  const drops: DropItem[] = visible.map((row) => ({
    id: row.id,
    connectionType: row.connectionType as MatchTypeName,
    score: row.score,
    reasons: Array.isArray(row.reasons) ? row.reasons.filter((reason): reason is string => typeof reason === 'string') : [],
    status: row.status,
    secondLook: row.secondLook,
    expiresAt: row.expiresAt.toISOString(),
    candidate: people.get(row.candidateId)!,
  }))
  return { ...base, drops }
}

export type PassOutcome = 'PASSED' | 'NOT_FOUND' | 'NOT_PENDING'

/** Passes on a drop of this user's. Idempotent for one already passed. */
export async function passDrop(db: Db, userId: string, dropId: string, now: Date = new Date()): Promise<PassOutcome> {
  const drop = await db.drop.findUnique({ where: { id: dropId }, select: { id: true, userId: true, candidateId: true, status: true, expiresAt: true } })
  // A drop that belongs to somebody else does not exist as far as the caller can tell.
  if (!drop || drop.userId !== userId) return 'NOT_FOUND'
  if (drop.status === 'PASSED') return 'PASSED'
  if (drop.status !== 'NEW' || drop.expiresAt.getTime() < now.getTime()) return 'NOT_PENDING'

  // What the person looks like now, so a later second look can tell whether they have grown.
  const snapshot = await proofSnapshot(db, drop.candidateId)
  const changed = await db.drop.updateMany({
    where: { id: dropId, userId, status: 'NEW' },
    data: { status: 'PASSED', ...(snapshot ? { passSnapshot: snapshot } : {}) },
  })
  if (changed.count === 1) return 'PASSED'
  // Lost a race with another answer to the same drop.
  const now2 = await db.drop.findUnique({ where: { id: dropId }, select: { status: true } })
  return now2?.status === 'PASSED' ? 'PASSED' : 'NOT_PENDING'
}
