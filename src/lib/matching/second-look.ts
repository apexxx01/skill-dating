import { Prisma, type PrismaClient } from '@prisma/client'
import { log } from '@/lib/log'
import { advisoryLock } from '@/lib/progress'
import { utcTimestamp } from '@/lib/sql'
import { addDaysToDateKey, localDateKey, localDayEnd, mondayOfDateKey } from '@/lib/time'
import { findCandidateIds, viewerFor } from './candidates'
import { DROP_CONFIG, SECOND_LOOK_CONFIG } from './config'
import { growthReason, growthSince, growthWeight, hasGrown, readSnapshot, type Growth, type ProofSnapshot } from './growth'
import { loadScoringProfiles, type ProfileCache } from './loader'
import { scoreCompatibility } from './score'
import { loadPersonSummaries } from './summary'
import type { MatchType } from './types'

// The second look: once a week, one person a viewer passed on who has since grown (a higher tier, or more verified evidence than when they were
// passed), brought back as an extra drop flagged `secondLook`. The pure half (what counts as growth) is in growth.ts.

type Db = PrismaClient

const DAY_MS = 24 * 60 * 60 * 1000

export type SecondLookSkip = 'GONE' | 'NO_PROFILE' | 'PAUSED' | 'ALREADY_THIS_WEEK'

export interface SecondLookUserResult {
  userId: string
  created: number
  skipped?: SecondLookSkip
}

export interface SecondLookRunResult {
  users: number
  created: number
  skipped: number
  durationMs: number
}

/** The people who have a pass old enough to look at again and no more than a few months old, and who can still be given drops. */
export async function secondLookUserIds(db: Pick<PrismaClient, '$queryRaw'>, now: Date = new Date()): Promise<string[]> {
  const youngest = utcTimestamp(new Date(now.getTime() - SECOND_LOOK_CONFIG.minPassAgeDays * DAY_MS))
  const oldest = utcTimestamp(new Date(now.getTime() - SECOND_LOOK_CONFIG.maxPassAgeDays * DAY_MS))
  const rows = await db.$queryRaw<{ userId: string }[]>`
    SELECT DISTINCT d."userId"
    FROM "Drop" d JOIN "MatchingProfile" mp ON mp."userId" = d."userId"
    WHERE d."status" = 'PASSED' AND d."passSnapshot" IS NOT NULL AND mp."paused" = false
      AND d."updatedAt" >= ${oldest} AND d."updatedAt" <= ${youngest}
    ORDER BY d."userId"
  `
  return rows.map((row) => row.userId)
}

interface Grower {
  candidateId: string
  connectionType: MatchType
  growth: Growth
  now: ProofSnapshot
  passedAt: Date
}

export async function generateSecondLookForUser(db: Db, userId: string, now: Date, options: { cache?: ProfileCache } = {}): Promise<SecondLookUserResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      timezone: true,
      deletedAt: true,
      profile: { select: { cityKey: true } },
      matchingProfile: true,
      skills: { select: { skill: { select: { slug: true } } } },
    },
  })
  if (!user || user.deletedAt) return { userId, created: 0, skipped: 'GONE' }
  const stored = user.matchingProfile
  if (!stored) return { userId, created: 0, skipped: 'NO_PROFILE' }
  if (stored.paused) return { userId, created: 0, skipped: 'PAUSED' }

  // One a local week (Monday to Sunday), however often this runs.
  const localDate = localDateKey(now, user.timezone)
  const weekStart = mondayOfDateKey(localDate)
  const weekEnd = addDaysToDateKey(weekStart, 6)
  const thisWeek = () => ({ userId, secondLook: true, localDate: { gte: weekStart, lte: weekEnd } })
  if ((await db.drop.count({ where: thisWeek() })) > 0) return { userId, created: 0, skipped: 'ALREADY_THIS_WEEK' }

  // Passes that are old enough to have changed and young enough to matter, newest first, one per person (their latest).
  const passes = await db.drop.findMany({
    where: {
      userId,
      status: 'PASSED',
      passSnapshot: { not: Prisma.DbNull },
      updatedAt: { gte: new Date(now.getTime() - SECOND_LOOK_CONFIG.maxPassAgeDays * DAY_MS), lte: new Date(now.getTime() - SECOND_LOOK_CONFIG.minPassAgeDays * DAY_MS) },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: { candidateId: true, connectionType: true, passSnapshot: true, updatedAt: true },
  })
  const latest = new Map<string, (typeof passes)[number]>()
  for (const pass of passes) if (!latest.has(pass.candidateId)) latest.set(pass.candidateId, pass)
  // Somebody already brought back since that pass is not brought back again (until they are passed again, which makes a new pass).
  const already = await db.drop.findMany({ where: { userId, secondLook: true, candidateId: { in: [...latest.keys()] } }, select: { candidateId: true, createdAt: true } })
  for (const earlier of already) {
    const pass = latest.get(earlier.candidateId)
    if (pass && earlier.createdAt.getTime() >= pass.updatedAt.getTime()) latest.delete(earlier.candidateId)
  }

  // Only for a type the viewer still has (the romance mode has no second look: it is one drop a week).
  const usable = new Set<MatchType>((stored.connectionTypes as MatchType[]).filter((type) => type !== 'DATING'))
  const people = await loadPersonSummaries(db, [...latest.keys()])
  const growers: Grower[] = []
  for (const pass of latest.values()) {
    const before = readSnapshot(pass.passSnapshot)
    const person = people.get(pass.candidateId)
    if (!before || !person || !usable.has(pass.connectionType as MatchType)) continue
    const current = { tier: person.tier, verifiedEvidence: person.proof.verifiedEvidence }
    const growth = growthSince(before, current)
    if (hasGrown(growth)) growers.push({ candidateId: pass.candidateId, connectionType: pass.connectionType as MatchType, growth, now: current, passedAt: pass.updatedAt })
  }
  growers.sort((a, b) => growthWeight(b.growth) - growthWeight(a.growth) || b.passedAt.getTime() - a.passedAt.getTime() || a.candidateId.localeCompare(b.candidateId))
  if (growers.length === 0) return { userId, created: 0 }

  // The same rules as any drop (blocks, matches, trust, pausing, the exposure cap), except that the 30 days after a pass do not apply.
  const viewer = await viewerFor(db, {
    userId,
    cityOnly: stored.cityOnly,
    cityKey: user.profile?.cityKey ?? null,
    lookingForSkills: stored.lookingForSkills,
    skillSlugs: user.skills.map((row) => row.skill.slug),
  })
  const eligible = new Map<MatchType, Set<string>>()
  for (const type of new Set(growers.map((grower) => grower.connectionType))) {
    const ids = growers.filter((grower) => grower.connectionType === type).map((grower) => grower.candidateId)
    eligible.set(type, new Set(await findCandidateIds(db, viewer, type, now, DROP_CONFIG, { onlyIds: ids, ignoreHistory: true })))
  }

  const [self] = await loadScoringProfiles(db, [userId], now, options.cache)
  if (!self) return { userId, created: 0 }
  const expiresAt = localDayEnd(now, user.timezone)

  for (const grower of growers) {
    if (!eligible.get(grower.connectionType)?.has(grower.candidateId)) continue
    const [candidate] = await loadScoringProfiles(db, [grower.candidateId], now, options.cache)
    if (!candidate) continue
    const result = scoreCompatibility({ viewer: self, candidate, connectionType: grower.connectionType, now })
    if (result.excluded) continue
    const reasons = [growthReason(grower.growth, grower.now), ...result.reasons].slice(0, 3)

    const created = await db.$transaction(
      async (tx) => {
        await advisoryLock(tx, `second-look:${userId}`)
        if ((await tx.drop.count({ where: thisWeek() })) > 0) return 0
        const { count } = await tx.drop.createMany({
          data: [{ userId, candidateId: grower.candidateId, connectionType: grower.connectionType, score: result.score, reasons: reasons as unknown as Prisma.InputJsonValue, localDate, secondLook: true, expiresAt }],
          skipDuplicates: true,
        })
        return count
      },
      { timeout: 15_000 }
    )
    // Somebody already shown today as an ordinary drop is skipped for the next best.
    if (created > 0) return { userId, created }
  }
  return { userId, created: 0 }
}

export async function runSecondLook(db: Db, options: { now?: Date; userIds?: readonly string[] } = {}): Promise<SecondLookRunResult> {
  const started = Date.now()
  const now = options.now ?? new Date()
  const ids = options.userIds ? [...new Set(options.userIds)] : await secondLookUserIds(db, now)
  const cache: ProfileCache = new Map()
  const result: SecondLookRunResult = { users: ids.length, created: 0, skipped: 0, durationMs: 0 }
  for (const userId of ids) {
    try {
      const one = await generateSecondLookForUser(db, userId, now, { cache })
      result.created += one.created
      if (one.skipped) result.skipped += 1
    } catch (error) {
      result.skipped += 1
      log.error('could not generate a second look', { error, userId })
    }
    if (cache.size > 20_000) cache.clear()
  }
  result.durationMs = Date.now() - started
  log.info('second looks generated', { ...result })
  return result
}

/** What the weekly job runs. */
export async function runSecondLookJob(data: { userIds?: string[] } = {}): Promise<SecondLookRunResult> {
  const { prisma } = await import('@/lib/prisma')
  return runSecondLook(prisma, { userIds: data.userIds })
}
