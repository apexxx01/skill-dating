import type { Prisma, PrismaClient, RiskLevel } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'
import { log } from '@/lib/log'
import { effectiveLevel, riskOf, type RiskFacts } from './risk'

// The nightly risk run (job `integrity/risk`) and the reads every request path uses. The score is recomputed for everyone with any signal and for
// everyone who already has a score (so a score falls again as old signals age out). A change of level is written to AuditEvent. Reads go through the
// Cache adapter: the set of people whose effective level is HIGH is cached for five minutes and dropped by every change (the job, an admin override).

type Db = PrismaClient

const DAY_MS = 24 * 60 * 60 * 1000
export const THROTTLE_SIGNAL = 'THROTTLE_HIT'
const HIGH_RISK_CACHE_KEY = 'risk:high'
const HIGH_RISK_TTL_MS = 5 * 60_000

async function countBy<T extends { _count: { _all: number } }>(rows: Promise<T[]>, key: (row: T) => string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const row of await rows) {
    const id = key(row)
    if (id) out.set(id, (out.get(id) ?? 0) + row._count._all)
  }
  return out
}

/** The facts behind each candidate's score. */
export async function gatherRiskFacts(db: Db, now: Date = new Date()): Promise<Map<string, RiskFacts>> {
  const d90 = new Date(now.getTime() - 90 * DAY_MS)
  const d30 = new Date(now.getTime() - 30 * DAY_MS)
  const [signals, reporters, blocks, throttles, velocity, existing] = await Promise.all([
    db.fraudSignal.findMany({ where: { status: { in: ['OPEN', 'CONFIRMED'] } }, select: { memberIds: true, score: true } }),
    db.report.findMany({ where: { createdAt: { gte: d90 }, status: { not: 'DISMISSED' }, reporterId: { not: null }, source: 'USER' }, select: { reportedId: true, reporterId: true }, distinct: ['reportedId', 'reporterId'] }),
    countBy(db.block.groupBy({ by: ['blockedId'], where: { createdAt: { gte: d90 } }, _count: { _all: true } }), (row) => row.blockedId),
    countBy(db.integritySignal.groupBy({ by: ['userId'], where: { kind: THROTTLE_SIGNAL, createdAt: { gte: d30 }, userId: { not: null } }, _count: { _all: true } }), (row) => row.userId),
    countBy(db.integritySignal.groupBy({ by: ['userId'], where: { kind: { not: THROTTLE_SIGNAL }, createdAt: { gte: d30 }, userId: { not: null } }, _count: { _all: true } }), (row) => row.userId),
    db.userRisk.findMany({ select: { userId: true } }),
  ])
  const collusion = new Map<string, number>()
  for (const signal of signals) for (const id of signal.memberIds) collusion.set(id, Math.max(collusion.get(id) ?? 0, signal.score))
  const reportCount = new Map<string, number>()
  for (const row of reporters) reportCount.set(row.reportedId, (reportCount.get(row.reportedId) ?? 0) + 1)

  const ids = new Set([...collusion.keys(), ...reportCount.keys(), ...blocks.keys(), ...throttles.keys(), ...velocity.keys(), ...existing.map((r) => r.userId)])
  if (ids.size === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: [...ids] }, deletedAt: null }, select: { id: true, birthDate: true, isEmailVerified: true } })
  return new Map(
    users.map((user) => [
      user.id,
      {
        collusionScore: collusion.get(user.id) ?? 0,
        distinctReporters90d: reportCount.get(user.id) ?? 0,
        blocksReceived90d: blocks.get(user.id) ?? 0,
        throttleHits30d: throttles.get(user.id) ?? 0,
        velocitySignals30d: velocity.get(user.id) ?? 0,
        hasBirthDate: user.birthDate !== null,
        emailVerified: user.isEmailVerified,
      },
    ])
  )
}

export async function runRiskScoring(db: Db, now: Date = new Date(), cache: Cache = getCache()): Promise<{ scored: number; changed: number }> {
  const facts = await gatherRiskFacts(db, now)
  let changed = 0
  for (const [userId, userFacts] of facts) {
    const result = riskOf(userFacts)
    const previous = await db.userRisk.findUnique({ where: { userId } })
    await db.$transaction(async (tx) => {
      await tx.userRisk.upsert({
        where: { userId },
        create: { userId, score: result.score, level: result.level, factors: result.factors, computedAt: now },
        update: { score: result.score, level: result.level, factors: result.factors, computedAt: now },
      })
      if ((previous?.level ?? 'LOW') !== result.level) {
        changed += 1
        await tx.auditEvent.create({
          data: { action: 'RISK_LEVEL_CHANGED', targetType: 'USER', targetId: userId, oldValue: { level: previous?.level ?? 'LOW', score: previous?.score ?? 0 }, newValue: { level: result.level, score: result.score, factors: result.factors } },
        })
      }
    })
  }
  await invalidateRiskCache(cache)
  log.info('risk scoring finished', { scored: facts.size, changed })
  return { scored: facts.size, changed }
}

export async function invalidateRiskCache(cache: Cache = getCache()): Promise<void> {
  await cache.del(HIGH_RISK_CACHE_KEY).catch(() => undefined)
}

/** Everyone whose effective level (an override wins) is HIGH. Cached; a cache failure reads the database. */
export async function highRiskUserIds(db: Pick<Db, 'userRisk'>, cache: Cache = getCache()): Promise<Set<string>> {
  try {
    const cached = await cache.get(HIGH_RISK_CACHE_KEY)
    if (cached) return new Set(JSON.parse(cached) as string[])
  } catch {
    // read the database
  }
  const rows = await db.userRisk.findMany({ where: { OR: [{ overrideLevel: 'HIGH' }, { level: 'HIGH', overrideLevel: null }] }, select: { userId: true } })
  const ids = rows.map((row) => row.userId)
  await cache.set(HIGH_RISK_CACHE_KEY, JSON.stringify(ids), { ttlMs: HIGH_RISK_TTL_MS }).catch(() => undefined)
  return new Set(ids)
}

export async function isHighRisk(db: Pick<Db, 'userRisk'>, userId: string, cache?: Cache): Promise<boolean> {
  return (await highRiskUserIds(db, cache)).has(userId)
}

/** An admin sets (or, with null, clears) the level that wins over the computed one. Audited. */
export async function overrideRisk(db: Db, input: { userId: string; level: RiskLevel | null; reason: string; adminId: string }, cache: Cache = getCache()) {
  const before = await db.userRisk.findUnique({ where: { userId: input.userId } })
  const row = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const saved = await tx.userRisk.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, score: 0, level: 'LOW', overrideLevel: input.level, overrideById: input.adminId, overrideReason: input.reason },
      update: { overrideLevel: input.level, overrideById: input.adminId, overrideReason: input.reason },
    })
    await tx.auditEvent.create({
      data: {
        userId: input.adminId,
        action: 'RISK_OVERRIDDEN',
        targetType: 'USER',
        targetId: input.userId,
        oldValue: { effective: effectiveLevel(before), overrideLevel: before?.overrideLevel ?? null },
        newValue: { effective: effectiveLevel(saved), overrideLevel: input.level, reason: input.reason },
      },
    })
    return saved
  })
  await invalidateRiskCache(cache)
  return row
}

/** Records that a person ran into a rate limit, at most once an hour per limit, for the risk score. Never throws. */
export async function recordThrottleHit(db: Pick<Db, 'integritySignal'>, userId: string, keyPrefix: string, cache: Cache = getCache()): Promise<void> {
  try {
    const { count } = await cache.hit(`throttle-signal:${userId}:${keyPrefix}`, 60 * 60_000)
    if (count !== 1) return
    await db.integritySignal.create({ data: { kind: THROTTLE_SIGNAL, userId, subjectType: 'USER', subjectId: userId, data: { limit: keyPrefix } } })
  } catch (error) {
    log.warn('could not record a throttle hit', { error, userId })
  }
}

export async function runRiskJob(): Promise<unknown> {
  const { prisma } = await import('@/lib/prisma')
  return runRiskScoring(prisma)
}
