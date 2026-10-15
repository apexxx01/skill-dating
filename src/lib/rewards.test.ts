import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { Db } from './events'

vi.mock('./subscribers', () => ({}))
const track = vi.fn().mockResolvedValue(undefined)
vi.mock('./infra/analytics', () => ({ track: (...args: unknown[]) => track(...args) }))

import { grant } from './rewards'
import { transactWithEvents } from './events'
import { xpAtLevelStart } from './levels'

interface Row {
  userId: string
  type: string
  amount: number
  dedupeKey: string
  createdAt: Date
}

// A small in-memory stand-in for the parts of the database grant() touches,
// including the unique index on (userId, type, dedupeKey).
function fakeDatabase(users: Record<string, { xp: number; timezone: string | null }>) {
  const rows: Row[] = []
  const notifications: { userId: string; metadata: { kind: string } }[] = []
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id]),
    },
    xPEvent: {
      findUnique: vi.fn(async ({ where }: { where: { userId_type_dedupeKey: { userId: string; type: string; dedupeKey: string } } }) => {
        const key = where.userId_type_dedupeKey
        return rows.find((row) => row.userId === key.userId && row.type === key.type && row.dedupeKey === key.dedupeKey) ? { id: 'x' } : null
      }),
      count: vi.fn(async ({ where }: { where: { userId: string; type: string; createdAt: { gte: Date } } }) =>
        rows.filter((row) => row.userId === where.userId && row.type === where.type && row.createdAt >= where.createdAt.gte).length
      ),
      createMany: vi.fn(async ({ data }: { data: Omit<Row, 'createdAt'>[] }) => {
        let count = 0
        for (const item of data) {
          if (rows.some((row) => row.userId === item.userId && row.type === item.type && row.dedupeKey === item.dedupeKey)) continue
          rows.push({ ...item, createdAt: pendingCreatedAt ?? new Date() })
          count += 1
        }
        return { count }
      }),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: { userId: string; metadata: { kind: string } } }) => void notifications.push(data)),
    },
    $executeRaw: vi.fn(async () => 1),
    // UPDATE "User" SET xp = xp + ${amount} WHERE id = ${userId} RETURNING xp
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, amount: number, userId: string) => {
      users[userId].xp += amount
      return [{ xp: users[userId].xp }]
    }),
  }
  let pendingCreatedAt: Date | undefined
  return {
    tx: tx as unknown as Db,
    rows,
    notifications,
    /** Where the next inserted row says it was created, standing in for the database clock. */
    createdAt(at: Date | undefined) {
      pendingCreatedAt = at
    },
    client: { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient,
  }
}

const project = (id: string) => ({ sourceType: 'PROJECT' as const, sourceId: id, description: `Created project ${id}` })

beforeEach(() => track.mockClear())

describe('grant', () => {
  it('pays the configured amount, stores what it was for, and reports the new total', async () => {
    const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
    const result = await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
    expect(result.granted).toBe(true)
    expect(result.envelope).toMatchObject({ xpGained: 50, totalXp: 50, oldLevel: 1, newLevel: 1, leveledUp: false })
    expect(db.rows).toEqual([expect.objectContaining({ userId: 'u1', type: 'PROJECT_CREATED', amount: 50, dedupeKey: 'project:p1' })])
    expect(db.tx.xPEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ sourceType: 'PROJECT', sourceId: 'p1', description: 'Created project p1' })], skipDuplicates: true })
    )
  })

  it('pays the same source only once, however often it is asked', async () => {
    const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
    await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
    for (let attempt = 0; attempt < 5; attempt++) {
      const again = await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
      expect(again).toMatchObject({ granted: false, reason: 'DUPLICATE' })
      expect(again.envelope).toMatchObject({ xpGained: 0, totalXp: 50 })
    }
    expect(db.rows).toHaveLength(1)
  })

  it('stops a race that gets past the check: the insert itself refuses the duplicate', async () => {
    const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
    await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
    // Both requests read "no award yet" before either wrote one.
    ;(db.tx.xPEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const loser = await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
    expect(loser).toMatchObject({ granted: false, reason: 'DUPLICATE' })
    expect(db.rows).toHaveLength(1)
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('treats each source as its own award, and each user as their own', async () => {
    const db = fakeDatabase({ u1: { xp: 0, timezone: null }, u2: { xp: 0, timezone: null } })
    expect((await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))).granted).toBe(true)
    expect((await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p2'))).granted).toBe(true)
    expect((await grant(db.tx, 'u2', 'PROJECT_CREATED', project('p1'))).granted).toBe(true)
  })

  it('cannot be farmed by creating projects in a loop: the 4th award of a day pays nothing', async () => {
    const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
    const results = []
    for (let index = 0; index < 12; index++) results.push(await grant(db.tx, 'u1', 'PROJECT_CREATED', project(`loop-${index}`)))
    expect(results.filter((result) => result.granted)).toHaveLength(3)
    expect(results[3]).toMatchObject({ granted: false, reason: 'DAILY_CAP' })
    expect(db.tx.user.findUnique).toBeDefined()
    expect(await db.tx.user.findUnique({ where: { id: 'u1' } } as never)).toMatchObject({ xp: 150 })
  })

  it('takes the cap lock before counting, so parallel requests line up', async () => {
    const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
    await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
    expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1)
    // Uncapped actions take no lock.
    await grant(db.tx, 'u1', 'HACKATHON_JOIN', { sourceType: 'HACKATHON', sourceId: 'h1', description: 'Joined' })
    expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1)
  })

  describe('every action', () => {
    // [action, source type, amount, daily cap]
    const actions = [
      ['MILESTONE_COMPLETED', 'MILESTONE', 30, 5],
      ['PROJECT_UPDATE_POSTED', 'PROJECT_UPDATE', 15, 3],
      ['EVIDENCE_ADDED', 'EVIDENCE', 20, 3],
      ['EVIDENCE_ENDORSED', 'ENDORSEMENT', 10, 10],
      ['CONNECTION_ACCEPTED', 'CONNECTION', 10, 5],
      ['MESSAGE_SENT_FIRST_IN_CONNECTION', 'CONVERSATION', 5, 5],
      ['TEAM_APPLICATION_ACCEPTED', 'TEAM_APPLICATION', 50, null],
    ] as const
    const source = (sourceType: (typeof actions)[number][1], id: string) => ({ sourceType, sourceId: id, description: `award ${id}` })

    it.each(actions)('%s pays its amount once per source', async (action, sourceType, amount) => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      const first = await grant(db.tx, 'u1', action, source(sourceType, 's1'))
      expect(first).toMatchObject({ granted: true, xp: amount })
      expect(db.rows).toEqual([expect.objectContaining({ type: action, amount, dedupeKey: `${sourceType.toLowerCase()}:s1` })])

      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await grant(db.tx, 'u1', action, source(sourceType, 's1'))).toMatchObject({ granted: false, reason: 'DUPLICATE' })
      }
      expect(db.rows).toHaveLength(1)
      expect((await grant(db.tx, 'u1', action, source(sourceType, 's2'))).granted).toBe(true)
    })

    it.each(actions)('%s refuses a source of the wrong kind', async (action, sourceType) => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      await expect(grant(db.tx, 'u1', action, { sourceType: 'PROJECT', sourceId: 's1', description: 'x' })).rejects.toThrow(sourceType)
    })

    it.each(actions.filter((entry) => entry[3] !== null))('%s stops paying after its daily cap, and starts again the next local day', async (action, sourceType, amount, cap) => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: 'Asia/Kolkata' } })
      const day = new Date('2026-03-10T10:00:00Z')
      db.createdAt(day)
      const results = []
      for (let index = 0; index < cap! + 4; index++) results.push(await grant(db.tx, 'u1', action, { ...source(sourceType, `s${index}`), now: day }))

      expect(results.filter((result) => result.granted)).toHaveLength(cap!)
      expect(results[cap!]).toMatchObject({ granted: false, reason: 'DAILY_CAP' })
      expect(await db.tx.user.findUnique({ where: { id: 'u1' } } as never)).toMatchObject({ xp: amount * cap! })

      // 18:30Z is Kolkata midnight.
      const nextDay = new Date('2026-03-10T18:30:00Z')
      expect((await grant(db.tx, 'u1', action, { ...source(sourceType, 'tomorrow'), now: nextDay })).granted).toBe(true)
    })

    it('does not cap a team application, however many are accepted in a day', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      for (let index = 0; index < 8; index++) {
        expect((await grant(db.tx, 'u1', 'TEAM_APPLICATION_ACCEPTED', source('TEAM_APPLICATION', `a${index}`))).granted).toBe(true)
      }
    })

    it('counts each action and each person separately against a cap', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null }, u2: { xp: 0, timezone: null } })
      for (let index = 0; index < 3; index++) await grant(db.tx, 'u1', 'PROJECT_UPDATE_POSTED', source('PROJECT_UPDATE', `u${index}`))
      expect((await grant(db.tx, 'u1', 'PROJECT_UPDATE_POSTED', source('PROJECT_UPDATE', 'u3'))).granted).toBe(false)
      expect((await grant(db.tx, 'u1', 'MILESTONE_COMPLETED', source('MILESTONE', 'm1'))).granted).toBe(true)
      expect((await grant(db.tx, 'u2', 'PROJECT_UPDATE_POSTED', source('PROJECT_UPDATE', 'u0'))).granted).toBe(true)
    })

    it('pays both sides of a connection from the same source', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null }, u2: { xp: 0, timezone: null } })
      expect((await grant(db.tx, 'u1', 'CONNECTION_ACCEPTED', source('CONNECTION', 'c1'))).granted).toBe(true)
      expect((await grant(db.tx, 'u2', 'CONNECTION_ACCEPTED', source('CONNECTION', 'c1'))).granted).toBe(true)
      expect((await grant(db.tx, 'u2', 'CONNECTION_ACCEPTED', source('CONNECTION', 'c1'))).granted).toBe(false)
    })
  })

  describe('daily caps reset at the local midnight of the user', () => {
    // Three awards were made at 2026-03-10T10:00Z. For each zone, ask one second
    // before and exactly at the next local midnight after that moment.
    const awardedAt = new Date('2026-03-10T10:00:00Z')
    const cases: [string, string, string][] = [
      // zone, last second of the day the awards were made on, first instant of the next day
      ['UTC', '2026-03-10T23:59:59Z', '2026-03-11T00:00:00Z'],
      ['Asia/Kolkata', '2026-03-10T18:29:59Z', '2026-03-10T18:30:00Z'],
      ['America/New_York', '2026-03-11T03:59:59Z', '2026-03-11T04:00:00Z'],
      ['Pacific/Kiritimati', '2026-03-11T09:59:59Z', '2026-03-11T10:00:00Z'],
      ['Pacific/Pago_Pago', '2026-03-10T10:59:59Z', '2026-03-10T11:00:00Z'],
    ]

    it.each(cases)('%s', async (timezone, before, after) => {
      const db = fakeDatabase({ u1: { xp: 0, timezone } })
      db.createdAt(awardedAt)
      for (const id of ['a', 'b', 'c']) expect((await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project(id), now: awardedAt })).granted).toBe(true)

      const sameDay = await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project('d'), now: new Date(before) })
      expect(sameDay).toMatchObject({ granted: false, reason: 'DAILY_CAP' })
      const nextDay = await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project('e'), now: new Date(after) })
      expect(nextDay.granted).toBe(true)
    })

    it('counts the same instants differently for people in different zones', async () => {
      // 20:00Z on the 10th is still the 10th in London but already the 11th in Kolkata:
      // after three awards at 10:00Z, only the person in Kolkata has a fresh day.
      const london = fakeDatabase({ u1: { xp: 0, timezone: 'Europe/London' } })
      const kolkata = fakeDatabase({ u1: { xp: 0, timezone: 'Asia/Kolkata' } })
      for (const db of [london, kolkata]) {
        db.createdAt(awardedAt)
        for (const id of ['a', 'b', 'c']) await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project(id), now: awardedAt })
      }
      const now = new Date('2026-03-10T20:00:00Z')
      expect((await grant(london.tx, 'u1', 'PROJECT_CREATED', { ...project('d'), now })).granted).toBe(false)
      expect((await grant(kolkata.tx, 'u1', 'PROJECT_CREATED', { ...project('d'), now })).granted).toBe(true)
    })

    it('falls back to UTC for a missing or invalid zone', async () => {
      for (const timezone of [null, 'Not/AZone']) {
        const db = fakeDatabase({ u1: { xp: 0, timezone } })
        db.createdAt(awardedAt)
        for (const id of ['a', 'b', 'c']) await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project(id), now: awardedAt })
        expect(await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project('d'), now: new Date('2026-03-10T23:59:59Z') })).toMatchObject({ reason: 'DAILY_CAP' })
        expect((await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project('e'), now: new Date('2026-03-11T00:00:00Z') })).granted).toBe(true)
      }
    })
  })

  describe('levels, tiers and notifications', () => {
    it('reports a level-up on the exact threshold and notifies once', async () => {
      const db = fakeDatabase({ u1: { xp: 50, timezone: null } })
      const result = await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
      expect(result.envelope).toMatchObject({ xpGained: 50, totalXp: 100, oldLevel: 1, newLevel: 2, leveledUp: true, tierChanged: false })
      expect(db.notifications.map((n) => n.metadata.kind)).toEqual(['LEVEL_UP'])
    })

    it('does not level up one XP short', async () => {
      const db = fakeDatabase({ u1: { xp: 9, timezone: null } })
      const result = await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
      expect(result.envelope).toMatchObject({ totalXp: 59, leveledUp: false })
      expect(db.notifications).toEqual([])
    })

    it('reports a tier change at the tier boundary, with both notifications', async () => {
      const silver = xpAtLevelStart(10)
      const db = fakeDatabase({ u1: { xp: silver - 10, timezone: null } })
      const result = await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
      expect(result.envelope).toMatchObject({ oldLevel: 9, newLevel: 10, oldTier: 'BRONZE', newTier: 'SILVER', tierChanged: true })
      expect(db.notifications.map((n) => n.metadata.kind)).toEqual(['LEVEL_UP', 'TIER_UP'])
    })

    it('does not notify for a level inside the same tier as a tier change', async () => {
      const db = fakeDatabase({ u1: { xp: 120, timezone: null } })
      await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
      expect(db.notifications.filter((n) => n.metadata.kind === 'TIER_UP')).toEqual([])
    })
  })

  describe('analytics', () => {
    it('tracks level_up and tier_up only after the transaction commits', async () => {
      const silver = xpAtLevelStart(10)
      const db = fakeDatabase({ u1: { xp: silver - 10, timezone: null } })
      let insideTransaction = 0
      await transactWithEvents(db.client, async (tx) => {
        await grant(tx, 'u1', 'PROJECT_CREATED', project('p1'))
        insideTransaction = track.mock.calls.length
      })
      expect(insideTransaction).toBe(0)
      expect(track.mock.calls.map((call) => call[1])).toEqual(['level_up', 'tier_up'])
      expect(track.mock.calls[1]).toEqual(['u1', 'tier_up', { tier: 'SILVER', level: 10 }])
    })

    it('tracks nothing when the transaction fails', async () => {
      const db = fakeDatabase({ u1: { xp: 90, timezone: null } })
      await expect(
        transactWithEvents(db.client, async (tx) => {
          await grant(tx, 'u1', 'PROJECT_CREATED', project('p1'))
          throw new Error('later step failed')
        })
      ).rejects.toThrow()
      expect(track).not.toHaveBeenCalled()
    })
  })

  describe('what the request reports', () => {
    it('merges several awards in one transaction into one envelope', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      const { scope } = await transactWithEvents(db.client, async (tx) => {
        await grant(tx, 'u1', 'PROJECT_CREATED', project('p1'))
        await grant(tx, 'u1', 'HACKATHON_JOIN', { sourceType: 'HACKATHON', sourceId: 'h1', description: 'Joined' })
      })
      expect(await scope.rewardsFor(db.tx, 'u1')).toMatchObject({ xpGained: 150, totalXp: 150, oldLevel: 1, newLevel: 2, leveledUp: true })
    })

    it('reports nothing earned, at the current total, for a duplicate', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      await grant(db.tx, 'u1', 'PROJECT_CREATED', project('p1'))
      const { scope } = await transactWithEvents(db.client, async (tx) => void (await grant(tx, 'u1', 'PROJECT_CREATED', project('p1'))))
      expect(await scope.rewardsFor(db.tx, 'u1')).toMatchObject({ xpGained: 0, totalXp: 50 })
    })
  })

  describe('refusals', () => {
    it('declines an achievement with no XP attached', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      const result = await grant(db.tx, 'u1', 'ACHIEVEMENT_EARNED', { sourceType: 'ACHIEVEMENT', sourceId: 'x', description: 'x', amount: 0 })
      expect(result).toMatchObject({ granted: false, reason: 'NO_REWARD' })
      expect(db.rows).toEqual([])
    })

    it('takes an achievement amount from the caller, and ignores a caller amount for fixed actions', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      const achievement = await grant(db.tx, 'u1', 'ACHIEVEMENT_EARNED', { sourceType: 'ACHIEVEMENT', sourceId: 'first-ship', description: 'x', amount: 100 })
      expect(achievement.envelope.xpGained).toBe(100)
      const fixed = await grant(db.tx, 'u1', 'PROJECT_CREATED', { ...project('p1'), amount: 999_999 })
      expect(fixed.envelope.xpGained).toBe(50)
    })

    it('rejects an award attached to the wrong kind of source', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      await expect(grant(db.tx, 'u1', 'PROJECT_CREATED', { sourceType: 'HACKATHON', sourceId: 'h1', description: 'x' })).rejects.toThrow(/PROJECT/)
      expect(db.rows).toEqual([])
    })

    it('rejects an unknown user instead of creating an orphan row', async () => {
      const db = fakeDatabase({})
      await expect(grant(db.tx, 'ghost', 'PROJECT_CREATED', project('p1'))).rejects.toThrow(/unknown user/)
      expect(db.rows).toEqual([])
    })

    it('rejects a fractional or negative achievement amount', async () => {
      const db = fakeDatabase({ u1: { xp: 0, timezone: null } })
      for (const amount of [1.5, -10]) {
        const result = await grant(db.tx, 'u1', 'ACHIEVEMENT_EARNED', { sourceType: 'ACHIEVEMENT', sourceId: `s${amount}`, description: 'x', amount })
        expect(result).toMatchObject({ granted: false, reason: 'NO_REWARD' })
      }
    })
  })
})
