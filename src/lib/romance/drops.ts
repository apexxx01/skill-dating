import type { PrismaClient } from '@prisma/client'
import { ageOn } from '@/lib/age'
import { datingBlockers } from '@/lib/matching/dating'
import { datingFactsSelect } from '@/lib/matching/profile'
import { chunk, shuffledForDay } from '@/lib/matching/drops'
import { scoreRomance } from '@/lib/matching/score'
import type { JobQueue } from '@/lib/infra/jobs'
import { log } from '@/lib/log'
import { createNotification } from '@/lib/notifications'
import { advisoryLock } from '@/lib/progress'
import { accountDistrust } from '@/lib/trust'
import { isValidTimeZone, localDateKey, localIsoWeekday, localTimeKey, localWeekEnd, localWeekKey } from '@/lib/time'
import { findRomanceCandidateIds, type RomanceViewer } from './candidates'
import { ROMANCE_CONFIG, romanceCopy, type Gender, type Scope } from './config'
import { countCharacterEndorsers } from './endorsers'
import { loadRomanceScoringProfiles, type RomanceProfileCache } from './loader'

// The weekly romance drop: ONE person, once a local ISO week, chosen for you.
//
//  - A person is due once their local week has begun and the drop time (Monday 08:00 local) has passed in it, and they have no drop for the week yet; someone who joins midweek is due at
//    the next run. A week with no one to show is looked at once a day until the week ends, not every hour.
//  - generateRomanceDropForUser() does one person: the pool from SQL (candidates.ts: the gate, the mutual filters, the inbox gate, blocks, history), scored by scoreRomance() over the pool,
//    the best one at or above the floor written in one transaction under a per-person lock. The exposure cap keeps popular people from being everybody's pick.
//  - dispatchRomanceDrops() is the hourly job: it splits the people who are due into batches per time zone and hands each batch to the queue (`romance/drops-batch`), exactly as the daily
//    drops are fanned out.
//
// Nothing here reads the professional pool, drops or matching profile, and the professional drops never read this.

type Db = PrismaClient

export interface RomanceDropRunOptions {
  now?: Date
  /** Generate for exactly these people. By default whether or not they are due; see `force`. */
  userIds?: readonly string[]
  force?: boolean
  cache?: RomanceProfileCache
}

export type RomanceDropSkip = 'GONE' | 'NO_PROFILE' | 'PAUSED' | 'NOT_ELIGIBLE' | 'ALREADY_GENERATED'

export interface RomanceUserResult {
  userId: string
  created: number
  considered: number
  skipped?: RomanceDropSkip
}

export interface RomanceRunResult {
  due: number
  generated: number
  drops: number
  skipped: number
  durationMs: number
}

/** Whether the week's drop time has come for a person in this zone: Monday from 08:00 local, or any later day of the week. */
export function dropTimePassed(now: Date, timeZone: string | null): boolean {
  const weekday = localIsoWeekday(now, timeZone)
  return weekday > ROMANCE_CONFIG.drop.weekdayLocal || localTimeKey(now, timeZone) >= ROMANCE_CONFIG.drop.timeLocal
}

// --- Who is due ---------------------------------------------------------------------------------------------

export interface RomanceDueZone {
  timezone: string | null
  ids: string[]
}

export async function dueRomanceByZone(db: Db, now: Date = new Date()): Promise<RomanceDueZone[]> {
  const zones = await db.$queryRaw<{ timezone: string | null }[]>`
    SELECT DISTINCT u."timezone"
    FROM "RomanceProfile" rp JOIN "User" u ON u."id" = rp."userId"
    WHERE rp."paused" = false AND u."deletedAt" IS NULL
  `
  const due: RomanceDueZone[] = []
  for (const { timezone } of zones) {
    const effective = isValidTimeZone(timezone) ? timezone : 'UTC'
    if (!dropTimePassed(now, effective)) continue
    const weekKey = localWeekKey(now, effective)
    const today = localDateKey(now, effective)
    const rows = await db.$queryRaw<{ userId: string }[]>`
      SELECT rp."userId"
      FROM "RomanceProfile" rp JOIN "User" u ON u."id" = rp."userId"
      WHERE rp."paused" = false AND u."deletedAt" IS NULL
        AND u."timezone" IS NOT DISTINCT FROM ${timezone}::text
        AND (rp."lastDropWeek" IS NULL OR rp."lastDropWeek" <> ${weekKey})
        AND (rp."lastDropTryDate" IS NULL OR rp."lastDropTryDate" <> ${today})
    `
    if (rows.length > 0) due.push({ timezone, ids: rows.map((row) => row.userId) })
  }
  return due
}

// --- One person ---------------------------------------------------------------------------------------------

export async function generateRomanceDropForUser(db: Db, userId: string, now: Date, options: { cache?: RomanceProfileCache; force?: boolean } = {}): Promise<RomanceUserResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      timezone: true,
      deletedAt: true,
      createdAt: true,
      ...datingFactsSelect,
      profile: { select: { cityKey: true, countryCode: true } },
      romanceProfile: true,
    },
  })
  if (!user || user.deletedAt) return { userId, created: 0, considered: 0, skipped: 'GONE' }
  const stored = user.romanceProfile
  if (!stored) return { userId, created: 0, considered: 0, skipped: 'NO_PROFILE' }
  if (stored.paused) return { userId, created: 0, considered: 0, skipped: 'PAUSED' }
  // The gate, again, at the moment of the drop: someone who lost eligibility (a phone removed) is shown to nobody and shown nobody.
  if (datingBlockers(user, now).length > 0 || accountDistrust(user, now) !== null) return { userId, created: 0, considered: 0, skipped: 'NOT_ELIGIBLE' }

  const weekKey = localWeekKey(now, user.timezone)
  const today = localDateKey(now, user.timezone)
  if (!options.force && stored.lastDropWeek === weekKey) return { userId, created: 0, considered: 0, skipped: 'ALREADY_GENERATED' }

  const endorsers = (await countCharacterEndorsers(db, [userId], now)).get(userId) ?? 0
  const viewer: RomanceViewer = {
    userId,
    gender: stored.gender as Gender,
    interestedIn: stored.interestedIn as Gender[],
    ageMin: stored.ageMin,
    ageMax: stored.ageMax,
    scope: stored.scope as Scope,
    age: ageOn(user.birthDate!, now),
    cityKey: user.profile?.cityKey ?? null,
    countryCode: user.profile?.countryCode ?? null,
    endorsers,
  }

  const cache = options.cache ?? new Map()
  const [self] = await loadRomanceScoringProfiles(db, [userId], now, cache)
  const ids = self ? await findRomanceCandidateIds(db, viewer, now) : []
  let considered = 0
  let best: { candidateId: string; score: number; reasons: string[] } | null = null
  for (const batch of chunk(ids, ROMANCE_CONFIG.drop.scoreBatch)) {
    for (const candidate of await loadRomanceScoringProfiles(db, batch, now, cache)) {
      considered += 1
      const result = scoreRomance({ viewer: self!, candidate, now })
      if (result.score < ROMANCE_CONFIG.drop.minScore) continue
      if (!best || result.score > best.score || (result.score === best.score && candidate.userId < best.candidateId)) {
        best = { candidateId: candidate.userId, score: result.score, reasons: result.reasons }
      }
    }
  }

  const expiresAt = localWeekEnd(now, user.timezone)
  const created = await db.$transaction(
    async (tx) => {
      // One generation per person at a time: whoever comes second finds the first one's drop and its marker.
      await advisoryLock(tx, `romance-drop:${userId}`)
      const fresh = await tx.romanceProfile.findUnique({ where: { userId }, select: { lastDropWeek: true, paused: true } })
      if (!fresh || fresh.paused || (!options.force && fresh.lastDropWeek === weekKey)) return 0
      if (!best) {
        await tx.romanceProfile.update({ where: { userId }, data: { lastDropTryDate: today } })
        return 0
      }
      const inserted = await tx.romanceDrop.createMany({
        data: [{ userId, candidateId: best.candidateId, score: best.score, reasons: best.reasons, weekKey, expiresAt }],
        skipDuplicates: true,
      })
      await tx.romanceProfile.update({ where: { userId }, data: { lastDropWeek: weekKey, lastDropTryDate: today } })
      if (inserted.count > 0) {
        await createNotification(tx, { userId, kind: 'ROMANCE_DROP', title: romanceCopy.newDrop, message: 'One person, chosen for how you build and how you live. They stay for the week.', link: '/romance', metadata: { weekKey } })
      }
      return inserted.count
    },
    { timeout: 15_000 }
  )
  return { userId, created, considered }
}

// --- Everybody who is due ---------------------------------------------------------------------------------------

export async function runRomanceDropGeneration(db: Db, options: RomanceDropRunOptions = {}): Promise<RomanceRunResult> {
  const started = Date.now()
  const now = options.now ?? new Date()
  const named = options.userIds !== undefined
  const forced = options.force ?? named
  const due = named ? [...new Set(options.userIds)] : (await dueRomanceByZone(db, now)).flatMap((zone) => zone.ids)
  const ids = shuffledForDay(due, now)
  const cache: RomanceProfileCache = options.cache ?? new Map()

  const result: RomanceRunResult = { due: ids.length, generated: 0, drops: 0, skipped: 0, durationMs: 0 }
  for (const userId of ids) {
    try {
      const one = await generateRomanceDropForUser(db, userId, now, { cache, force: forced })
      if (one.skipped) result.skipped += 1
      else {
        result.generated += 1
        result.drops += one.created
      }
    } catch (error) {
      result.skipped += 1
      log.error('could not generate a romance drop for a user', { error, userId })
    }
    if (cache.size > 20_000) cache.clear()
  }
  result.durationMs = Date.now() - started
  log.info('romance drops generated', { ...result })
  return result
}

export interface RomanceDispatchResult {
  due: number
  zones: number
  batches: number
}

const hourKey = (now: Date) => now.toISOString().slice(0, 13)

export async function dispatchRomanceDrops(db: Db, queue: JobQueue, now: Date = new Date(), batchSize: number = ROMANCE_CONFIG.drop.userBatch): Promise<RomanceDispatchResult> {
  const zones = await dueRomanceByZone(db, now)
  const result: RomanceDispatchResult = { due: 0, zones: zones.length, batches: 0 }
  for (const zone of zones) {
    const ids = shuffledForDay(zone.ids, now)
    result.due += ids.length
    const zoneKey = (zone.timezone ?? 'UTC').replace(/[^A-Za-z0-9_+-]/g, '_')
    for (const [index, userIds] of chunk(ids, batchSize).entries()) {
      await queue.enqueue('romance/drops-batch', { userIds }, { id: `romance-drops:${hourKey(now)}:${zoneKey}:${index}` })
      result.batches += 1
    }
  }
  log.info('romance drops dispatched', { ...result })
  return result
}

/** What the hourly job runs. With `userIds` it generates for those people right away; otherwise it dispatches the batches. */
export async function runRomanceDropsJob(data: { userIds?: string[] } = {}): Promise<RomanceRunResult | RomanceDispatchResult> {
  const { prisma } = await import('@/lib/prisma')
  if (data.userIds) return runRomanceDropGeneration(prisma, { userIds: data.userIds })
  const { getJobQueue } = await import('@/lib/infra/jobs')
  return dispatchRomanceDrops(prisma, getJobQueue())
}

/** What one batch runs: the people of it who are still due. Safe to run twice. */
export async function runRomanceBatchJob(data: { userIds: string[] }): Promise<RomanceRunResult> {
  const { prisma } = await import('@/lib/prisma')
  return runRomanceDropGeneration(prisma, { userIds: data.userIds, force: false })
}
