import { createHash } from 'crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { limit, subjectFor } from '@/lib/entitlements'
import { log } from '@/lib/log'
import { advisoryLock } from '@/lib/progress'
import { isValidTimeZone, localDateKey, localDayEnd, localTimeKey } from '@/lib/time'
import type { JobQueue } from '@/lib/infra/jobs'
import { findCandidateIds, viewerFor } from './candidates'
import { DROP_CONFIG } from './config'
import { datingBlockers } from './dating'
import { loadScoringProfiles, type ProfileCache } from './loader'
import { datingFactsSelect } from './profile'
import { scoreCompatibility } from './score'
import { selectDrops, type ScoredCandidate } from './select'
import type { MatchType } from './types'

// Daily drops: every person gets a few other people, chosen for them, once a day at the time they picked.
//
//  - dispatchDropGeneration() is the hourly job: it finds the people whose chosen time has passed in THEIR time zone and who have no drops
//    for their local day yet, splits each time zone's people into batches (DROP_CONFIG.fanOutBatch) and enqueues one `drops/generate-batch`
//    job per batch, so the batches run in parallel on the job workers instead of one worker walking the whole hour.
//  - runDropGeneration() is what a batch (or an operator naming people) runs: it generates for its people one at a time (so the exposure
//    cap sees what the people before them in the batch were shown). The order is shuffled by the day, so the same people are not always first
//    at the popular candidates.
//  - generateDropsForUser() does one person: candidates from SQL (candidates.ts), scored in batches by the pure scorer, the best few
//    chosen (select.ts), written in one transaction under a per-person lock that re-checks, so two runs at once cannot give anyone more.
//
// Complexity and timings are in docs/MATCHING.md.

type Db = PrismaClient

export interface DropRunOptions {
  /** The moment to generate for. Defaults to now. */
  now?: Date
  /** Generate for exactly these people instead of everyone who is due. By default whether or not they are due; see `force`. */
  userIds?: readonly string[]
  /** Generate even for somebody who already has today's drops. Defaults to true when `userIds` is given (an operator asking) and false otherwise. A batch passes false. */
  force?: boolean
  /** Whether plan limits apply (defaults to ENTITLEMENTS_ENFORCED). */
  enforced?: boolean
  cache?: ProfileCache
}

export type DropSkip = 'GONE' | 'NO_PROFILE' | 'PAUSED' | 'NO_TYPES' | 'ALREADY_GENERATED'

export interface UserDropResult {
  userId: string
  created: number
  /** How many candidates the database handed back and the scorer looked at. */
  considered: number
  skipped?: DropSkip
}

export interface DropRunResult {
  due: number
  generated: number
  drops: number
  skipped: number
  durationMs: number
}

// --- Who is due ---------------------------------------------------------------------------------------------

export interface DueZone {
  /** The IANA name as stored, or null for people with none (they are on UTC). */
  timezone: string | null
  ids: string[]
}

/**
 * The people whose drop time has passed in their own time zone today and who have not been given today's drops, grouped by the time zone they are
 * in: the zones in use are looked up once, and each zone's people are one query. Their ids only.
 */
export async function dueUsersByZone(db: Db, now: Date = new Date()): Promise<DueZone[]> {
  const zones = await db.$queryRaw<{ timezone: string | null }[]>`
    SELECT DISTINCT u."timezone"
    FROM "MatchingProfile" mp JOIN "User" u ON u."id" = mp."userId"
    WHERE mp."paused" = false AND u."deletedAt" IS NULL AND cardinality(mp."connectionTypes") > 0
  `
  const due: DueZone[] = []
  for (const { timezone } of zones) {
    // A zone this runtime does not know counts as UTC, the same as everywhere else.
    const effective = isValidTimeZone(timezone) ? timezone : 'UTC'
    const localDate = localDateKey(now, effective)
    const clock = localTimeKey(now, effective)
    const rows = await db.$queryRaw<{ userId: string }[]>`
      SELECT mp."userId"
      FROM "MatchingProfile" mp JOIN "User" u ON u."id" = mp."userId"
      WHERE mp."paused" = false AND u."deletedAt" IS NULL AND cardinality(mp."connectionTypes") > 0
        AND u."timezone" IS NOT DISTINCT FROM ${timezone}::text
        AND mp."dropTimeLocal" <= ${clock}
        AND (mp."lastDropDate" IS NULL OR mp."lastDropDate" < ${localDate})
    `
    if (rows.length > 0) due.push({ timezone, ids: rows.map((row) => row.userId) })
  }
  return due
}

/** Everybody who is due, in no particular order. */
export async function dueUserIds(db: Db, now: Date = new Date()): Promise<string[]> {
  return (await dueUsersByZone(db, now)).flatMap((zone) => zone.ids)
}

/** The people in a stable order that changes every day, so nobody is always first in line for the candidates everyone wants. */
export function shuffledForDay(ids: readonly string[], now: Date): string[] {
  const day = now.toISOString().slice(0, 10)
  const key = (id: string) => createHash('sha1').update(`${day}:${id}`).digest('hex')
  return [...ids].sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b))
}

// --- One person ---------------------------------------------------------------------------------------------

export async function generateDropsForUser(
  db: Db,
  userId: string,
  now: Date,
  options: { enforced?: boolean; cache?: ProfileCache; force?: boolean } = {}
): Promise<UserDropResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      timezone: true,
      deletedAt: true,
      ...datingFactsSelect,
      profile: { select: { cityKey: true } },
      matchingProfile: true,
      skills: { select: { skill: { select: { slug: true } } } },
    },
  })
  if (!user || user.deletedAt) return { userId, created: 0, considered: 0, skipped: 'GONE' }
  const stored = user.matchingProfile
  if (!stored) return { userId, created: 0, considered: 0, skipped: 'NO_PROFILE' }
  if (stored.paused) return { userId, created: 0, considered: 0, skipped: 'PAUSED' }
  if (stored.connectionTypes.length === 0) return { userId, created: 0, considered: 0, skipped: 'NO_TYPES' }

  const localDate = localDateKey(now, user.timezone)
  if (!options.force && stored.lastDropDate === localDate) return { userId, created: 0, considered: 0, skipped: 'ALREADY_GENERATED' }

  const selected = stored.connectionTypes as MatchType[]
  // Dating only for somebody who still passes the gate; the other types are unaffected.
  const datingOpen = datingBlockers(user, now).length === 0
  const types = selected.filter((type) => type !== 'DATING' || datingOpen)

  const subject = await subjectFor(db, userId, now)
  const allowance = limit(subject, 'DAILY_DROPS', { enforced: options.enforced })
  const countToday = (client: Pick<PrismaClient, 'drop'>) => client.drop.count({ where: { userId, localDate, secondLook: false } })
  const room = allowance - (await countToday(db))

  const scored: ScoredCandidate[] = []
  let considered = 0
  if (room > 0 && types.length > 0) {
    const [self] = await loadScoringProfiles(db, [userId], now, options.cache)
    if (self) {
      const viewer = await viewerFor(db, {
        userId,
        cityOnly: stored.cityOnly,
        cityKey: user.profile?.cityKey ?? null,
        lookingForSkills: stored.lookingForSkills,
        skillSlugs: user.skills.map((row) => row.skill.slug),
      })
      for (const type of types) {
        const ids = await findCandidateIds(db, viewer, type, now)
        for (let from = 0; from < ids.length; from += DROP_CONFIG.scoreBatch) {
          for (const candidate of await loadScoringProfiles(db, ids.slice(from, from + DROP_CONFIG.scoreBatch), now, options.cache)) {
            considered += 1
            const result = scoreCompatibility({ viewer: self, candidate, connectionType: type, now })
            if (!result.excluded) scored.push({ candidateId: candidate.userId, connectionType: type, score: result.score, reasons: result.reasons })
          }
        }
      }
    }
  }
  const chosen = selectDrops(scored, { count: room, singleType: selected.length === 1, minScore: DROP_CONFIG.minScore })
  const expiresAt = localDayEnd(now, user.timezone)

  const created = await db.$transaction(
    async (tx) => {
      // One generation per person at a time: whoever comes second finds the first one's drops and its marker.
      await advisoryLock(tx, `drops:${userId}`)
      const fresh = await tx.matchingProfile.findUnique({ where: { userId }, select: { lastDropDate: true, paused: true } })
      if (!fresh || fresh.paused || (!options.force && fresh.lastDropDate === localDate)) return 0
      const left = allowance - (await countToday(tx))
      const data: Prisma.DropCreateManyInput[] = chosen.slice(0, Math.max(0, left)).map((pick) => ({
        userId,
        candidateId: pick.candidateId,
        connectionType: pick.connectionType,
        score: pick.score,
        reasons: pick.reasons as unknown as Prisma.InputJsonValue,
        localDate,
        expiresAt,
      }))
      const inserted = data.length > 0 ? (await tx.drop.createMany({ data, skipDuplicates: true })).count : 0
      await tx.matchingProfile.update({ where: { userId }, data: { lastDropDate: localDate } })
      return inserted
    },
    { timeout: 15_000 }
  )
  return { userId, created, considered }
}

// --- Everybody who is due ---------------------------------------------------------------------------------------

export async function runDropGeneration(db: Db, options: DropRunOptions = {}): Promise<DropRunResult> {
  const started = Date.now()
  const now = options.now ?? new Date()
  const named = options.userIds !== undefined
  const forced = options.force ?? named
  const ids = shuffledForDay(named ? [...new Set(options.userIds)] : await dueUserIds(db, now), now)
  // Profiles loaded for one person are reused for the next, within this run only.
  const cache: ProfileCache = options.cache ?? new Map()

  const result: DropRunResult = { due: ids.length, generated: 0, drops: 0, skipped: 0, durationMs: 0 }
  for (let from = 0; from < ids.length; from += DROP_CONFIG.userBatch) {
    for (const userId of ids.slice(from, from + DROP_CONFIG.userBatch)) {
      try {
        const one = await generateDropsForUser(db, userId, now, { enforced: options.enforced, cache, force: forced })
        if (one.skipped) result.skipped += 1
        else {
          result.generated += 1
          result.drops += one.created
        }
      } catch (error) {
        // One person's failure must not stop everybody else's drops; they are tried again at the next run.
        result.skipped += 1
        log.error('could not generate drops for a user', { error, userId })
      }
    }
    // A batch is done: what was loaded for it is not needed by the next, which is a different set of viewers with mostly different candidates.
    if (cache.size > 20_000) cache.clear()
  }
  result.durationMs = Date.now() - started
  log.info('daily drops generated', { ...result })
  return result
}

// --- Fan-out ----------------------------------------------------------------------------------------------------

export interface DispatchResult {
  /** People who are due this hour. */
  due: number
  zones: number
  /** Batch jobs enqueued. */
  batches: number
}

/** "2026-10-18T09": the hour a dispatch belongs to, so a repeated dispatch of the same hour enqueues the same batches (the queue drops repeated ids). */
const hourKey = (now: Date) => now.toISOString().slice(0, 13)

/** Splits `items` into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let from = 0; from < items.length; from += size) out.push(items.slice(from, from + size))
  return out
}

/**
 * The hourly job: finds who is due, and hands each time zone's people to the job queue in batches of DROP_CONFIG.fanOutBatch, each batch its own
 * `drops/generate-batch` job. The people of a zone are shuffled for the day first and then cut, so every batch is a fair mix and no batch
 * is always first at the candidates everybody wants. This does no scoring itself: it is a few queries and a few enqueues, however many people are due.
 */
export async function dispatchDropGeneration(db: Db, queue: JobQueue, now: Date = new Date(), batchSize: number = DROP_CONFIG.fanOutBatch): Promise<DispatchResult> {
  const zones = await dueUsersByZone(db, now)
  const result: DispatchResult = { due: 0, zones: zones.length, batches: 0 }
  for (const zone of zones) {
    const ids = shuffledForDay(zone.ids, now)
    result.due += ids.length
    const zoneKey = (zone.timezone ?? 'UTC').replace(/[^A-Za-z0-9_+-]/g, '_')
    const batches = chunk(ids, batchSize)
    for (const [index, userIds] of batches.entries()) {
      await queue.enqueue('drops/generate-batch', { userIds }, { id: `drops:${hourKey(now)}:${zoneKey}:${index}` })
      result.batches += 1
    }
  }
  log.info('daily drops dispatched', { ...result })
  return result
}

// --- Expiry -------------------------------------------------------------------------------------------------------

/** Marks drops nobody answered by the end of their day as EXPIRED. */
export async function expireDrops(db: Pick<PrismaClient, 'drop'>, now: Date = new Date()): Promise<{ expired: number }> {
  const { count } = await db.drop.updateMany({ where: { status: 'NEW', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } })
  return { expired: count }
}


/**
 * What the hourly job runs. With `userIds` (an operator asking) it generates for those people right away, whether or not they are due; without, it
 * dispatches the batches for everybody who is due.
 */
export async function runDropGenerationJob(data: { userIds?: string[] } = {}): Promise<DropRunResult | DispatchResult> {
  const { prisma } = await import('@/lib/prisma')
  if (data.userIds) return runDropGeneration(prisma, { userIds: data.userIds })
  const { getJobQueue } = await import('@/lib/infra/jobs')
  return dispatchDropGeneration(prisma, getJobQueue())
}

/** What one batch runs: generate for these people, those of them who are still due. Safe to run twice: a person who already has today's drops is skipped. */
export async function runDropBatchJob(data: { userIds: string[] }): Promise<DropRunResult> {
  const { prisma } = await import('@/lib/prisma')
  return runDropGeneration(prisma, { userIds: data.userIds, force: false })
}

/** What the expiry job runs. */
export async function runDropExpiryJob(): Promise<{ expired: number }> {
  const { prisma } = await import('@/lib/prisma')
  return expireDrops(prisma)
}
