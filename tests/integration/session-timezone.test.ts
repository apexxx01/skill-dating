import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { INTEGRATION_DATABASE_URL } from './config'
import { testPrisma } from './db'
import { heatmapRange, loadHeatmap } from '../../src/lib/heatmap'
import { recomputeRarity, RARITY_WINDOW_DAYS } from '../../src/lib/achievement-rarity'
import { withUtcSession } from '../../src/lib/database-url'
import { recordTick } from '../../src/lib/metrics'

// The DateTime columns hold UTC in a `timestamp` (no zone) column. Anything that converts between that and a
// timestamptz goes through the SESSION time zone, so a query that compares or writes a Date without converting it
// explicitly is right on a UTC session and hours off on any other. Each query below runs on sessions in several zones
// (opened with the same `options` parameter the application uses for UTC) and must answer the same on all of them.

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const ZONES = ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Pago_Pago']

function sessionIn(zone: string): PrismaClient {
  const url = new URL(INTEGRATION_DATABASE_URL)
  url.searchParams.set('options', `-c timezone=${zone}`)
  return new PrismaClient({ datasources: { db: { url: url.toString().replace(/\+/g, '%20') } } })
}

describe('queries give the same answer on a database session in any time zone', () => {
  const tag = `tz${Date.now().toString(36)}`
  const sessions = new Map<string, PrismaClient>()
  const userIds: string[] = []
  const now = new Date()

  beforeAll(async () => {
    for (const zone of ZONES) sessions.set(zone, sessionIn(zone))
  })

  afterAll(async () => {
    await testPrisma.user.deleteMany({ where: { id: { in: userIds } } })
    await Promise.all([...sessions.values()].map((client) => client.$disconnect()))
  })

  const makeUser = async (suffix: string, lastActiveAt: Date, timezone: string | null = null) => {
    const user = await testPrisma.user.create({
      data: { email: `${tag}${suffix}@test.dev`, username: `${tag}${suffix}`, lastActiveAt, timezone },
      select: { id: true },
    })
    userIds.push(user.id)
    return user.id
  }

  it('the sessions really are in the zones they were opened with', async () => {
    for (const zone of ZONES) {
      const [row] = await sessions.get(zone)!.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
      expect(row.tz).toBe(zone)
    }
  })

  it('the application connection option puts a session in UTC whatever the database default is', async () => {
    const url = new URL(withUtcSession(INTEGRATION_DATABASE_URL))
    const client = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    try {
      const [row] = await client.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
      expect(row.tz).toBe('UTC')
    } finally {
      await client.$disconnect()
    }
  })

  it('the heatmap counts the same days and the same XP from every session', async () => {
    const userId = await makeUser('heat', now, 'Asia/Kolkata')
    const range = heatmapRange(7, 'Asia/Kolkata', now)
    // Events a couple of hours either side of the first instant of the window: any session that reads the boundary
    // in its own zone moves it by hours and includes or drops one of them.
    const edge = range.since.getTime()
    const at = [-3 * HOUR, -30 * 60_000, 30 * 60_000, 3 * HOUR, 2 * DAY + 20 * HOUR]
    for (const [index, offset] of at.entries()) {
      await testPrisma.xPEvent.create({
        data: {
          userId,
          type: 'PROJECT_UPDATE_POSTED',
          amount: 10 + index,
          description: 'tz',
          sourceType: 'TEST',
          sourceId: `${tag}${index}`,
          dedupeKey: `${tag}:heat:${index}`,
          createdAt: new Date(edge + offset),
        },
      })
    }

    const answers = new Map<string, unknown>()
    for (const zone of ZONES) answers.set(zone, await loadHeatmap(sessions.get(zone)!, userId, range))

    const reference = answers.get('UTC') as { date: string; xp: number }[]
    // Only the three events at or after the window start are in it (the two before it are not), whatever the session zone.
    expect(reference.reduce((sum, day) => sum + day.xp, 0)).toBe(12 + 13 + 14)
    for (const zone of ZONES) expect(answers.get(zone), zone).toEqual(reference)
  })

  it('achievement rarity counts the same active users and stamps the same instant from every session', async () => {
    const since = now.getTime() - RARITY_WINDOW_DAYS * DAY
    // Active just inside the window and just outside it: a session that misreads the cutoff by its offset swaps them.
    const inside = await makeUser('in', new Date(since + 2 * HOUR))
    const outside = await makeUser('out', new Date(since - 2 * HOUR))
    const insideNearEnd = await makeUser('near', new Date(since + 13 * HOUR))
    const outsideFar = await makeUser('far', new Date(since - 13 * HOUR))
    expect([inside, outside, insideNearEnd, outsideFar]).toHaveLength(4)

    const results = new Map<string, { activeUsers: number; achievements: number }>()
    const stamps = new Map<string, number | undefined>()
    for (const zone of ZONES) {
      const result = await recomputeRarity(sessions.get(zone)!, now)
      results.set(zone, { activeUsers: result.activeUsers, achievements: result.achievements })
      const row = await testPrisma.achievement.findFirst({ select: { rarityUpdatedAt: true } })
      stamps.set(zone, row?.rarityUpdatedAt?.getTime())
    }

    const reference = results.get('UTC')!
    for (const zone of ZONES) {
      expect(results.get(zone), zone).toEqual(reference)
      // The stored instant is `now` exactly, however the session reads clocks.
      expect(stamps.get(zone), zone).toBe(now.getTime())
    }
    // The count is the real one: the two inside users count and the two outside do not.
    const real = await testPrisma.user.count({ where: { lastActiveAt: { gte: new Date(since) }, deletedAt: null } })
    expect(reference.activeUsers).toBe(real)
  })

  it('counters are stamped with the same instant whatever the session zone', async () => {
    const stamped: Date[] = []
    for (const zone of ZONES) {
      const userId = await makeUser(`ctr${zone.replace(/\W/g, '')}`, now)
      const client = sessions.get(zone)!
      await client.$transaction((tx) => recordTick(tx, { userId, metric: 'replies', dedupeKey: `${tag}:${zone}` }, now))
      const counter = await testPrisma.userCounter.findFirstOrThrow({ where: { userId, key: 'replies' }, select: { updatedAt: true } })
      stamped.push(counter.updatedAt)
    }
    for (const value of stamped) expect(value.getTime()).toBe(now.getTime())
  })
})
