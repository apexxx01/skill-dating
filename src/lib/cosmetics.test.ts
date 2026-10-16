import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { Db, TransactionalContext, DomainEventName } from './events'
import { backfillCosmetics, COSMETIC_EVENTS, equip, grantSeasonCosmetics, NOTHING_EQUIPPED, readEquipped, sourceOf, unlockCosmetics, unlockForEvent } from './cosmetics'
import { xpAtLevelStart } from './levels'

function fakeTx(owned: string[] = []) {
  const granted: { userId: string; cosmeticId: string; source: string }[] = []
  const have = new Set(owned)
  const notifications: unknown[] = []
  return {
    granted,
    notifications,
    have,
    tx: {
      userCosmetic: {
        findMany: vi.fn(async () => [...have].map((slug) => ({ cosmetic: { slug } }))),
        createMany: vi.fn(async ({ data }: { data: { userId: string; cosmeticId: string; source: string }[] }) => {
          let count = 0
          for (const row of data) {
            const slug = row.cosmeticId.replace(/^id-/, '')
            if (have.has(slug)) continue
            have.add(slug)
            granted.push(row)
            count += 1
          }
          return { count }
        }),
      },
      cosmetic: { upsert: vi.fn(async ({ where }: { where: { slug: string } }) => ({ id: `id-${where.slug}` })) },
      notification: { create: vi.fn(async ({ data }: { data: unknown }) => void notifications.push(data)) },
    } as unknown as Db,
  }
}

describe('unlockCosmetics', () => {
  it('grants what the trigger earns, records the source and tells the user', async () => {
    const { tx, granted, notifications } = fakeTx()
    const result = await unlockCosmetics(tx, 'u1', { kind: 'ACHIEVEMENT', slug: 'hackathon-champion' })
    expect(result.map((c) => c.slug).sort()).toEqual(['banner-champion', 'title-champion'])
    expect(granted.map((row) => [row.userId, row.source])).toEqual([['u1', 'achievement:hackathon-champion'], ['u1', 'achievement:hackathon-champion']])
    expect(notifications).toHaveLength(2)
    expect(notifications[0]).toMatchObject({ userId: 'u1', type: 'ACHIEVEMENT', title: 'New cosmetic', metadata: { kind: 'COSMETIC_UNLOCKED' } })
  })

  it('grants nothing for a trigger no rule matches', async () => {
    const { tx, granted } = fakeTx()
    expect(await unlockCosmetics(tx, 'u1', { kind: 'ACHIEVEMENT', slug: 'first-project' })).toEqual([])
    expect(await unlockCosmetics(tx, 'u1', { kind: 'STREAK', days: 3 })).toEqual([])
    expect(granted).toEqual([])
  })

  it('grants a cosmetic once: asking again, or having it already, grants nothing and costs one query', async () => {
    const { tx, granted } = fakeTx()
    await unlockCosmetics(tx, 'u1', { kind: 'STREAK', days: 7 })
    expect(await unlockCosmetics(tx, 'u1', { kind: 'STREAK', days: 7 })).toEqual([])
    expect(granted).toHaveLength(1)
    const owner = fakeTx(['frame-streak-7'])
    expect(await unlockCosmetics(owner.tx, 'u1', { kind: 'STREAK', days: 7 })).toEqual([])
    expect((owner.tx as unknown as { cosmetic: { upsert: ReturnType<typeof vi.fn> } }).cosmetic.upsert).not.toHaveBeenCalled()
  })

  it('catches a person up on every tier title up to the one they reached, and only the ones they lack', async () => {
    const { tx, granted } = fakeTx(['title-bronze'])
    const result = await unlockCosmetics(tx, 'u1', { kind: 'TIER', tier: 'GOLD' })
    expect(result.map((c) => c.slug)).toEqual(['title-silver', 'title-gold'])
    expect(granted).toHaveLength(2)
  })

  it('can be quiet, for catching people up', async () => {
    const { tx, notifications } = fakeTx()
    await unlockCosmetics(tx, 'u1', { kind: 'TIER', tier: 'SILVER' }, { notify: false })
    expect(notifications).toEqual([])
  })

  it('writes down where each came from', () => {
    expect(sourceOf({ kind: 'TIER', tier: 'GOLD' })).toBe('tier:GOLD')
    expect(sourceOf({ kind: 'ACHIEVEMENT', slug: 'ship-100' })).toBe('achievement:ship-100')
    expect(sourceOf({ kind: 'STREAK', days: 30 })).toBe('streak:30')
  })
})

describe('unlockForEvent', () => {
  const context = (name: DomainEventName, payload: unknown, tx: Db) => ({ name, payload, tx }) as unknown as TransactionalContext<DomainEventName>

  it('turns the three events that earn a cosmetic into triggers', async () => {
    expect([...COSMETIC_EVENTS].sort()).toEqual(['ACHIEVEMENT_UNLOCKED', 'STREAK_EXTENDED', 'TIER_REACHED'])
    const a = fakeTx()
    await unlockForEvent(context('TIER_REACHED', { userId: 'u1', tier: 'SILVER', level: 10 }, a.tx))
    expect(a.granted.map((row) => row.source)).toEqual(['tier:SILVER', 'tier:SILVER'])
    const b = fakeTx()
    await unlockForEvent(context('ACHIEVEMENT_UNLOCKED', { userId: 'u1', slug: 'ship-100' }, b.tx))
    expect(b.granted.map((row) => row.source)).toEqual(['achievement:ship-100'])
    const c = fakeTx()
    await unlockForEvent(context('STREAK_EXTENDED', { userId: 'u1', current: 30, longest: 30, freezeUsedInRun: false }, c.tx))
    expect(c.granted.map((row) => row.source)).toEqual(['streak:30', 'streak:30'])
  })

  it('ignores every other event', async () => {
    const { tx, granted } = fakeTx()
    await unlockForEvent(context('PROJECT_CREATED', { userId: 'u1', projectId: 'p', projectName: 'P' }, tx))
    expect(granted).toEqual([])
  })
})

describe('grantSeasonCosmetics', () => {
  /** A transaction that records the four grants (one per award) and what each was asked to do. */
  function seasonTx(ranked: number, granted: number[] = [0, 0, 0, 0]) {
    const upserts: { slug: string; create: Record<string, unknown> }[] = []
    const statements: { text: string; values: unknown[] }[] = []
    const tx = {
      $queryRaw: vi.fn(async () => [{ ranked }]),
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: strings.join('?'), values })
        return granted[statements.length - 1] ?? 0
      }),
      cosmetic: {
        upsert: vi.fn(async ({ where, create }: { where: { slug: string }; create: Record<string, unknown> }) => {
          upserts.push({ slug: where.slug, create })
          return { id: `id-${where.slug}` }
        }),
      },
    }
    return { tx: tx as unknown as Db, upserts, statements }
  }
  const at = new Date('2026-12-11T00:00:00Z')

  it('makes the season’s four cosmetics from its number, once each, in order', async () => {
    const { tx, upserts } = seasonTx(500)
    await grantSeasonCosmetics(tx, { id: 's3', number: 3 }, at)
    expect(upserts.map((upsert) => upsert.slug)).toEqual(['season-3-top-100', 'season-3-top-1-percent', 'season-3-top-10-percent', 'season-3-participant'])
    expect(upserts.map((upsert) => upsert.create.type)).toEqual(['TITLE', 'FRAME', 'FRAME', 'AVATAR_PART'])
    expect(upserts.map((upsert) => upsert.create.name)).toEqual(['Season 3 Top 100', 'Season 3 Top 1%', 'Season 3 Top 10%', 'Season 3 Participant'])
  })

  it('gives each award to the ranks it reaches in a season of that size, and reports who got what', async () => {
    const { tx, statements } = seasonTx(250, [100, 3, 25, 400])
    const grants = await grantSeasonCosmetics(tx, { id: 's1', number: 1 }, at)
    expect(grants).toEqual([
      { award: 'TOP_100', cutoff: 100, granted: 100 },
      { award: 'TOP_1_PERCENT', cutoff: 3, granted: 3 },
      { award: 'TOP_10_PERCENT', cutoff: 25, granted: 25 },
      { award: 'PARTICIPANT', cutoff: null, granted: 400 },
    ])
    expect(statements).toHaveLength(4)
    // Rank awards read the final standings; the badge reads the log.
    for (const statement of statements.slice(0, 3)) expect(JSON.stringify(statement.values)).toContain('SeasonStanding')
    expect(JSON.stringify(statements[3].values)).toContain('XPEvent')
  })

  it('only ever inserts into the inventory and the notifications: it pays no XP and touches no other table', async () => {
    const { tx, statements } = seasonTx(10)
    await grantSeasonCosmetics(tx, { id: 's1', number: 1 }, at)
    for (const statement of statements) {
      expect(statement.text).toMatch(/INSERT INTO "UserCosmetic"/)
      expect(statement.text).toMatch(/ON CONFLICT \("userId", "cosmeticId"\) DO NOTHING/)
      expect(statement.text).toMatch(/INSERT INTO "Notification"/)
      expect(statement.text).not.toMatch(/XPEvent"\s*\(|UPDATE "User"|"xp"/)
    }
  })

  it('tells only the people who were newly given it', async () => {
    const { tx, statements } = seasonTx(10)
    await grantSeasonCosmetics(tx, { id: 's1', number: 1 }, at)
    // The notification is written from the rows the grant returned, in the same statement, so it cannot go to anybody else.
    for (const statement of statements) expect(statement.text).toMatch(/WITH granted AS \([\s\S]*RETURNING "userId"[\s\S]*FROM granted/)
  })

  it('records where each came from, so an operator can see why somebody has it', async () => {
    const { tx, statements } = seasonTx(10)
    await grantSeasonCosmetics(tx, { id: 's4', number: 4 }, at)
    const sources = statements.map((statement) => statement.values.find((value) => typeof value === 'string' && value.startsWith('season:')))
    expect(sources).toEqual(['season:4:top_100', 'season:4:top_1_percent', 'season:4:top_10_percent', 'season:4:participant'])
  })

  it('grants nothing by rank in a season nobody was ranked in, but still offers the badge to anyone who played', async () => {
    const { tx, statements } = seasonTx(0, [0, 0, 0, 2])
    const grants = await grantSeasonCosmetics(tx, { id: 's1', number: 1 }, at)
    expect(grants.map((grant) => grant.cutoff)).toEqual([0, 0, 0, null])
    expect(grants[3].granted).toBe(2)
    expect(statements).toHaveLength(4)
  })
})

describe('readEquipped', () => {
  it('reads the three slots, tolerating whatever is stored', () => {
    expect(readEquipped({ title: 'title-gold', frame: 'frame-streak-7', banner: 'banner-shipper' })).toEqual({ title: 'title-gold', frame: 'frame-streak-7', banner: 'banner-shipper' })
    expect(readEquipped({})).toEqual(NOTHING_EQUIPPED)
    expect(readEquipped(null)).toEqual(NOTHING_EQUIPPED)
    expect(readEquipped([])).toEqual(NOTHING_EQUIPPED)
    expect(readEquipped('title-gold')).toEqual(NOTHING_EQUIPPED)
  })

  it('drops unknown cosmetics, other keys and values that are not text', () => {
    expect(readEquipped({ title: 'title-from-the-future', frame: 7, banner: null, hat: 'title-gold' })).toEqual(NOTHING_EQUIPPED)
  })

  it('keeps a season’s title and frame', () => {
    expect(readEquipped({ title: 'season-2-top-100', frame: 'season-2-top-1-percent', banner: 'season-9-participant' })).toEqual({ title: 'season-2-top-100', frame: 'season-2-top-1-percent', banner: 'season-9-participant' })
  })
})

describe('equip', () => {
  function fakeDb(owned: string[], equipped: unknown = {}) {
    const update = vi.fn(async () => ({}))
    return {
      update,
      db: {
        user: { findUnique: vi.fn(async () => ({ equipped })), update },
        userCosmetic: { findMany: vi.fn(async ({ where }: { where: { cosmetic: { slug: { in: string[] } } } }) => where.cosmetic.slug.in.filter((slug) => owned.includes(slug)).map((slug) => ({ cosmetic: { slug } }))) },
      } as never,
    }
  }

  it('wears what the user owns, in the right slots', async () => {
    const { db, update } = fakeDb(['title-gold', 'frame-streak-7', 'banner-shipper'])
    const outcome = await equip(db, 'u1', { title: 'title-gold', frame: 'frame-streak-7', banner: 'banner-shipper' })
    expect(outcome).toEqual({ ok: true, equipped: { title: 'title-gold', frame: 'frame-streak-7', banner: 'banner-shipper' } })
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { equipped: { title: 'title-gold', frame: 'frame-streak-7', banner: 'banner-shipper' } } })
  })

  it('refuses a cosmetic the user has not earned, and changes nothing', async () => {
    const { db, update } = fakeDb(['title-bronze'])
    expect(await equip(db, 'u1', { title: 'title-mythic' })).toEqual({ ok: false, reason: 'NOT_OWNED', slug: 'title-mythic' })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses one earned by somebody else, one that does not exist and one in the wrong slot', async () => {
    const { db, update } = fakeDb(['title-gold'])
    expect(await equip(db, 'u1', { banner: 'title-gold' })).toEqual({ ok: false, reason: 'WRONG_SLOT', slug: 'title-gold' })
    expect(await equip(db, 'u1', { title: 'title-does-not-exist' })).toEqual({ ok: false, reason: 'NOT_OWNED', slug: 'title-does-not-exist' })
    expect(await equip(db, 'u1', { title: 'frame-streak-365' })).toMatchObject({ ok: false, reason: 'WRONG_SLOT' })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses the whole request when any slot is not allowed', async () => {
    const { db, update } = fakeDb(['title-gold'])
    expect(await equip(db, 'u1', { title: 'title-gold', frame: 'frame-streak-365' })).toMatchObject({ ok: false, reason: 'NOT_OWNED' })
    expect(update).not.toHaveBeenCalled()
  })

  it('takes a cosmetic off with null, and leaves the slots that are not mentioned', async () => {
    const { db } = fakeDb(['frame-streak-7'], { title: 'title-gold', frame: 'frame-streak-7' })
    expect(await equip(db, 'u1', { title: null })).toEqual({ ok: true, equipped: { title: null, frame: 'frame-streak-7', banner: null } })
  })

  it('does not ask the database about ownership when it is only taking things off', async () => {
    const { db } = fakeDb([], { title: 'title-gold' })
    await equip(db, 'u1', { title: null, banner: null })
    expect((db as unknown as { userCosmetic: { findMany: ReturnType<typeof vi.fn> } }).userCosmetic.findMany).not.toHaveBeenCalled()
  })
})

describe('backfillCosmetics', () => {
  function fakePrisma(users: { id: string; xp: number; longestStreak: number; slugs: string[] }[]) {
    const granted: string[] = []
    const tx = {
      userCosmetic: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async ({ data }: { data: { cosmeticId: string; userId: string }[] }) => {
          granted.push(...data.map((row) => `${row.userId}:${row.cosmeticId}`))
          return { count: 1 }
        }),
      },
      cosmetic: { upsert: vi.fn(async ({ where }: { where: { slug: string } }) => ({ id: where.slug })) },
      notification: { create: vi.fn() },
    }
    return {
      granted,
      tx,
      prisma: {
        user: {
          findMany: vi.fn(async ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
            const start = cursor ? users.findIndex((u) => u.id === cursor.id) + 1 : 0
            return users.slice(start, start + take).map((u) => ({ id: u.id, xp: u.xp, longestStreak: u.longestStreak, achievements: u.slugs.map((slug) => ({ achievement: { slug } })) }))
          }),
        },
        $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      } as never,
    }
  }

  it('gives people what their XP, streak and achievements would have earned, quietly', async () => {
    const { prisma, granted, tx } = fakePrisma([{ id: 'u1', xp: xpAtLevelStart(20), longestStreak: 31, slugs: ['ship-100'] }])
    const result = await backfillCosmetics(prisma)
    expect(result).toEqual({ users: 1, granted: expect.any(Number), next: null })
    expect(granted).toEqual(expect.arrayContaining(['u1:title-bronze', 'u1:title-silver', 'u1:title-gold', 'u1:frame-streak-7', 'u1:frame-streak-30', 'u1:title-centurion']))
    expect(granted).not.toContain('u1:title-platinum')
    expect(granted).not.toContain('u1:frame-streak-100')
    expect(tx.notification.create).not.toHaveBeenCalled()
  })

  it('works in batches and says where to carry on', async () => {
    const users = Array.from({ length: 5 }, (_, index) => ({ id: `u${index}`, xp: 10, longestStreak: 0, slugs: [] }))
    const { prisma } = fakePrisma(users)
    const first = await backfillCosmetics(prisma, { limit: 2 })
    expect(first).toMatchObject({ users: 2, next: 'u1' })
    const second = await backfillCosmetics(prisma, { limit: 2, after: first.next! })
    expect(second).toMatchObject({ users: 2, next: 'u3' })
    const last = await backfillCosmetics(prisma, { limit: 2, after: second.next! })
    expect(last).toMatchObject({ users: 1, next: null })
  })
})

// "Never purchasable" is a rule about the whole code base, so it is checked against the whole code base.
describe('cosmetics are only ever earned', () => {
  const ROOT = path.resolve(__dirname, '..', '..')
  const SRC = path.join(ROOT, 'src')
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : []
    })
  const files = walk(SRC)
  const text = (file: string) => fs.readFileSync(file, 'utf-8')
  const rel = (file: string) => path.relative(SRC, file)

  const WRITES_INVENTORY = /(userCosmetic|UserCosmetic)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|INSERT\s+INTO\s+"UserCosmetic"|UPDATE\s+"UserCosmetic"|DELETE\s+FROM\s+"UserCosmetic"/
  const WRITES_CATALOG = /\bcosmetic\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|INSERT\s+INTO\s+"Cosmetic"/

  it('finds the source files to scan', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(path.join(SRC, 'lib', 'cosmetics.ts'))
  })

  it('has no code outside src/lib/cosmetics.ts that gives anyone a cosmetic or edits the catalog (a season’s rewards included)', () => {
    const offenders = files.filter((file) => file !== path.join(SRC, 'lib', 'cosmetics.ts')).filter((file) => WRITES_INVENTORY.test(text(file)) || WRITES_CATALOG.test(text(file))).map(rel)
    expect(offenders).toEqual([])
  })

  it('does find the writes inside the module, so the scan is not blind', () => {
    const source = text(path.join(SRC, 'lib', 'cosmetics.ts'))
    expect(WRITES_INVENTORY.test(source)).toBe(true)
    expect(WRITES_CATALOG.test(source)).toBe(true)
    expect(WRITES_INVENTORY.test('await tx.userCosmetic.createMany({ data })')).toBe(true)
    expect(WRITES_INVENTORY.test('prisma.userCosmetic.upsert({})')).toBe(true)
    expect(WRITES_CATALOG.test('await tx.cosmetic.upsert({})')).toBe(true)
    expect(WRITES_INVENTORY.test('db.userCosmetic.findMany({})')).toBe(false)
  })

  it('has no route that calls the unlock functions: a request cannot earn a cosmetic', () => {
    const routes = files.filter((file) => rel(file).startsWith(path.join('app', 'api')))
    expect(routes.length).toBeGreaterThan(30)
    const offenders = routes.filter((file) => /\b(unlockCosmetics|unlockForEvent|backfillCosmetics|runCosmeticsBackfill|grantSeasonCosmetics|grantSeasonRewards|grantPendingSeasonRewards)\b/.test(text(file))).map(rel)
    expect(offenders).toEqual([])
  })

  it('has no purchase, shop or store route, and no price in the data model or the error catalog', () => {
    const routes = files.filter((file) => rel(file).startsWith(path.join('app', 'api'))).map(rel)
    expect(routes.filter((route) => /purchase|\bbuy\b|shop|store|checkout|price|payment/i.test(route))).toEqual([])
    const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf-8')
    const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('\n}', schema.indexOf(`model ${name} {`)))
    for (const name of ['Cosmetic', 'UserCosmetic']) expect(model(name), name).not.toMatch(/price|cost|currency|amount|stripe|payment|coins?/i)
  })

  it('lets a client do exactly one thing with cosmetics: read them, and choose what to wear', () => {
    const routes = files.filter((file) => /app\/api\/users\/me\/(cosmetics|equipped)\/route\.ts$/.test(file.split(path.sep).join('/')))
    expect(routes.map((file) => path.basename(path.dirname(file))).sort()).toEqual(['cosmetics', 'equipped'])
    const methods = (file: string) => [...text(file).matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1])
    const byRoute = Object.fromEntries(routes.map((file) => [path.basename(path.dirname(file)), methods(file)]))
    expect(byRoute).toEqual({ cosmetics: ['GET'], equipped: ['PATCH'] })
  })
})
