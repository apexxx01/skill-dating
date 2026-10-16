import { Prisma, type PrismaClient } from '@prisma/client'
import type { DomainEventName, TransactionalContext, Db } from '@/lib/events'
import { cosmeticDefinition, matchingCosmetics, seasonAwardCutoffs, seasonCosmetic, SEASON_AWARDS, SLOT_OF, type CosmeticDefinition, type SeasonAward, type UnlockTrigger } from '@/lib/cosmetic-definitions'
import { levelFor } from '@/lib/levels'
import { utcTimestamp } from '@/lib/sql'

// The ONLY code that gives anyone a cosmetic. A cosmetic is earned by something that happens to a person (a
// tier reached, an achievement unlocked, a streak extended), announced as a domain event by the rewards
// engine; the subscriber below asks which cosmetics have an unlock rule that event satisfies and grants those.
// The one other way in is a season closing: grantSeasonCosmetics() gives the season's title, frames and badge from
// its final standings, called only by the season rewards code in src/lib/seasons.ts (the rollover job).
// There is no other way in: no route calls unlockCosmetics, nothing is for sale, and
// src/lib/cosmetics.test.ts scans the code base to keep it that way.

type Tx = Prisma.TransactionClient

/** Words for `UserCosmetic.source`: what unlocked it. */
export function sourceOf(trigger: UnlockTrigger): string {
  switch (trigger.kind) {
    case 'TIER':
      return `tier:${trigger.tier}`
    case 'ACHIEVEMENT':
      return `achievement:${trigger.slug}`
    case 'STREAK':
      return `streak:${trigger.days}`
  }
}

/**
 * Grants every cosmetic whose rule `trigger` satisfies and the user does not have yet, and tells them about
 * each. Safe to call as often as you like: a cosmetic is granted once (the unique key on user and
 * cosmetic decides), and what the user already has costs one query. Returns what was newly granted.
 */
export async function unlockCosmetics(db: Db, userId: string, trigger: UnlockTrigger, options: { notify?: boolean } = {}): Promise<CosmeticDefinition[]> {
  const tx = db as Tx
  const wanted = matchingCosmetics(trigger)
  if (wanted.length === 0) return []

  const have = await tx.userCosmetic.findMany({
    where: { userId, cosmetic: { slug: { in: wanted.map((cosmetic) => cosmetic.slug) } } },
    select: { cosmetic: { select: { slug: true } } },
  })
  const owned = new Set(have.map((row) => row.cosmetic.slug))

  const granted: CosmeticDefinition[] = []
  for (const cosmetic of wanted) {
    if (owned.has(cosmetic.slug)) continue
    // The catalog row is created from the definition the first time anyone earns it; an operator's later edits to it stay.
    const row = await tx.cosmetic.upsert({
      where: { slug: cosmetic.slug },
      create: {
        slug: cosmetic.slug,
        type: cosmetic.type,
        name: cosmetic.name,
        description: cosmetic.description,
        rarity: cosmetic.rarity,
        unlockRule: cosmetic.unlockRule as unknown as Prisma.InputJsonValue,
        order: cosmetic.order,
      },
      update: {},
      select: { id: true },
    })
    const inserted = await tx.userCosmetic.createMany({ data: [{ userId, cosmeticId: row.id, source: sourceOf(trigger) }], skipDuplicates: true })
    if (inserted.count === 0) continue
    granted.push(cosmetic)
    if (options.notify === false) continue
    await tx.notification.create({
      data: {
        userId,
        type: 'ACHIEVEMENT',
        title: 'New cosmetic',
        message: cosmetic.name,
        metadata: { kind: 'COSMETIC_UNLOCKED', slug: cosmetic.slug, cosmeticType: cosmetic.type },
      },
    })
  }
  return granted
}

/** The subscriber: turns the three events that can earn a cosmetic into a trigger. */
export async function unlockForEvent(context: TransactionalContext<DomainEventName>): Promise<void> {
  switch (context.name) {
    case 'TIER_REACHED': {
      const payload = context.payload as { userId: string; tier: Extract<UnlockTrigger, { kind: 'TIER' }>['tier'] }
      await unlockCosmetics(context.tx, payload.userId, { kind: 'TIER', tier: payload.tier })
      return
    }
    case 'ACHIEVEMENT_UNLOCKED': {
      const payload = context.payload as { userId: string; slug: string }
      await unlockCosmetics(context.tx, payload.userId, { kind: 'ACHIEVEMENT', slug: payload.slug })
      return
    }
    case 'STREAK_EXTENDED': {
      const payload = context.payload as { userId: string; current: number }
      await unlockCosmetics(context.tx, payload.userId, { kind: 'STREAK', days: payload.current })
      return
    }
  }
}

/** The events the cosmetics subscriber listens to. */
export const COSMETIC_EVENTS = ['TIER_REACHED', 'ACHIEVEMENT_UNLOCKED', 'STREAK_EXTENDED'] as const satisfies readonly DomainEventName[]

// --- A season closing --------------------------------------------------------------------------------

export interface SeasonCosmeticGrant {
  award: SeasonAward
  /** The last rank that got it, for the awards given by rank; null for the badge, which everyone who played gets. */
  cutoff: number | null
  /** People who got it now (not counting anybody who already had it). */
  granted: number
}

/**
 * Gives out a closed season's cosmetics: "Season N Top 100" to the 100 best, a top 1% and a top 10% frame by rank, and a
 * participation badge to everyone who earned XP in it. They are read from the season's final standings (the badge, from the log, since
 * somebody who switched leaderboards off has no standing but did play). Nothing here pays XP. Safe to run again: a
 * cosmetic a person already has is left alone, and only the people newly given one are told.
 */
export async function grantSeasonCosmetics(db: Db, season: { id: string; number: number }, at: Date = new Date()): Promise<SeasonCosmeticGrant[]> {
  const tx = db as Tx
  const [{ ranked }] = await tx.$queryRaw<{ ranked: number }[]>`SELECT COUNT(*)::int AS "ranked" FROM "SeasonStanding" WHERE "seasonId" = ${season.id}`
  const cutoffs = seasonAwardCutoffs(ranked)
  const when = utcTimestamp(at)
  const results: SeasonCosmeticGrant[] = []

  for (const award of SEASON_AWARDS) {
    const cosmetic = seasonCosmetic(season.number, award)
    const row = await tx.cosmetic.upsert({
      where: { slug: cosmetic.slug },
      create: {
        slug: cosmetic.slug,
        type: cosmetic.type,
        name: cosmetic.name,
        description: cosmetic.description,
        rarity: cosmetic.rarity,
        unlockRule: cosmetic.unlockRule as unknown as Prisma.InputJsonValue,
        order: cosmetic.order,
      },
      update: {},
      select: { id: true },
    })
    const source = `season:${season.number}:${award.toLowerCase()}`
    const note = JSON.stringify({ kind: 'COSMETIC_UNLOCKED', slug: cosmetic.slug, cosmeticType: cosmetic.type, season: season.number })

    // Who it is for: by rank from the final standings, or everybody who earned in the season. Deleted accounts get nothing.
    const recipients =
      award === 'PARTICIPANT'
        ? Prisma.sql`SELECT e."userId" FROM "XPEvent" e JOIN "User" u ON u."id" = e."userId" AND u."deletedAt" IS NULL WHERE e."seasonId" = ${season.id} GROUP BY e."userId" HAVING SUM(e."amount") > 0`
        : Prisma.sql`SELECT s."userId" FROM "SeasonStanding" s JOIN "User" u ON u."id" = s."userId" AND u."deletedAt" IS NULL WHERE s."seasonId" = ${season.id} AND s."rank" <= ${cutoffs[award]}`
    // One statement: grant, and tell exactly the people who did not have it yet.
    const granted = await tx.$executeRaw`
      WITH granted AS (
        INSERT INTO "UserCosmetic" ("id", "userId", "cosmeticId", "source", "unlockedAt")
        SELECT gen_random_uuid()::text, r."userId", ${row.id}, ${source}, ${when} FROM (${recipients}) r
        ON CONFLICT ("userId", "cosmeticId") DO NOTHING
        RETURNING "userId"
      )
      INSERT INTO "Notification" ("id", "userId", "type", "title", "message", "metadata", "isRead", "createdAt")
      SELECT gen_random_uuid()::text, "userId", 'ACHIEVEMENT', 'New cosmetic', ${cosmetic.name}, ${note}::jsonb, false, ${when} FROM granted
    `
    results.push({ award, cutoff: award === 'PARTICIPANT' ? null : cutoffs[award], granted })
  }
  return results
}

// --- Wearing them ------------------------------------------------------------------------------------

export interface Equipped {
  title: string | null
  frame: string | null
  banner: string | null
}

export const NOTHING_EQUIPPED: Equipped = { title: null, frame: null, banner: null }

/** What `User.equipped` holds, tolerating anything stored there: unknown keys and non-text values are dropped. */
export function readEquipped(value: Prisma.JsonValue | null | undefined): Equipped {
  const stored = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const slot = (key: keyof Equipped) => (typeof stored[key] === 'string' && cosmeticDefinition(stored[key] as string) !== undefined ? (stored[key] as string) : null)
  return { title: slot('title'), frame: slot('frame'), banner: slot('banner') }
}

export type EquipOutcome =
  | { ok: true; equipped: Equipped }
  | { ok: false; reason: 'NOT_OWNED' | 'WRONG_SLOT'; slug: string }

/**
 * Changes what a user wears. Each slot given is either null (take it off) or the slug of a cosmetic that
 * the user OWNS and that belongs in that slot; a slot left out stays as it is. Nothing is granted here: this only
 * chooses among what the user has already earned.
 */
export async function equip(db: Pick<PrismaClient, 'user' | 'userCosmetic'>, userId: string, change: Partial<Equipped>): Promise<EquipOutcome> {
  const wanted = (Object.entries(change) as [keyof Equipped, string | null | undefined][]).filter(([, slug]) => slug !== undefined)
  const slugs = wanted.map(([, slug]) => slug).filter((slug): slug is string => typeof slug === 'string')

  for (const [slot, slug] of wanted) {
    if (typeof slug !== 'string') continue
    const definition = cosmeticDefinition(slug)
    // An unknown slug is answered like one the user does not own, so nobody can probe for cosmetics they have not seen.
    if (!definition) return { ok: false, reason: 'NOT_OWNED', slug }
    if (SLOT_OF[definition.type] !== slot) return { ok: false, reason: 'WRONG_SLOT', slug }
  }

  if (slugs.length > 0) {
    const owned = await db.userCosmetic.findMany({ where: { userId, cosmetic: { slug: { in: slugs } } }, select: { cosmetic: { select: { slug: true } } } })
    const have = new Set(owned.map((row) => row.cosmetic.slug))
    const missing = slugs.find((slug) => !have.has(slug))
    if (missing) return { ok: false, reason: 'NOT_OWNED', slug: missing }
  }

  const current = readEquipped((await db.user.findUnique({ where: { id: userId }, select: { equipped: true } }))?.equipped)
  const next: Equipped = { ...current }
  for (const [slot, slug] of wanted) next[slot] = slug ?? null
  await db.user.update({ where: { id: userId }, data: { equipped: next as unknown as Prisma.InputJsonValue } })
  return { ok: true, equipped: next }
}

// --- People who earned things before cosmetics existed -------------------------------------------------

export interface BackfillResult {
  users: number
  granted: number
  /** Pass as `after` to continue; null when everybody has been done. */
  next: string | null
}

/**
 * Gives the people who already have XP, achievements and streaks the cosmetics those would have earned, since
 * the events that earn them fired before cosmetics existed. It goes through the same rules and the same
 * function as everything else, quietly (no notification per cosmetic), a batch of users at a time, and can be
 * run again: anything already granted is left alone.
 */
export async function backfillCosmetics(prisma: PrismaClient, options: { after?: string; limit?: number } = {}): Promise<BackfillResult> {
  const limit = options.limit ?? 500
  const batch = await prisma.user.findMany({
    where: { deletedAt: null, xp: { gt: 0 } },
    orderBy: { id: 'asc' },
    take: limit,
    ...(options.after ? { cursor: { id: options.after }, skip: 1 } : {}),
    select: { id: true, xp: true, longestStreak: true, achievements: { select: { achievement: { select: { slug: true } } } } },
  })

  let granted = 0
  for (const user of batch) {
    await prisma.$transaction(async (tx) => {
      const quietly = { notify: false }
      granted += (await unlockCosmetics(tx, user.id, { kind: 'TIER', tier: levelFor(user.xp).tier }, quietly)).length
      if (user.longestStreak > 0) granted += (await unlockCosmetics(tx, user.id, { kind: 'STREAK', days: user.longestStreak }, quietly)).length
      for (const earned of user.achievements) granted += (await unlockCosmetics(tx, user.id, { kind: 'ACHIEVEMENT', slug: earned.achievement.slug }, quietly)).length
    })
  }
  return { users: batch.length, granted, next: batch.length === limit ? batch[batch.length - 1].id : null }
}

/** What the backfill job runs. */
export async function runCosmeticsBackfill(options: { after?: string; limit?: number }): Promise<BackfillResult> {
  const { prisma } = await import('@/lib/prisma')
  return backfillCosmetics(prisma, options)
}
