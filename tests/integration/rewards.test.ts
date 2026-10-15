import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { loadEnvLocal } from './env'
import { INTEGRATION_DATABASE_URL } from './config'
import { levelFor, xpAtLevelStart } from '../../src/lib/levels'

// The rewards engine through the real routes and the real database: what a
// request reports, what is stored, and what cannot be farmed. The engine is also
// called directly where a test needs to control the clock or run it in parallel.
Object.assign(process.env, { ...loadEnvLocal(), DATABASE_URL: INTEGRATION_DATABASE_URL })

describe('rewards engine', () => {
  const suffix = uniqueSuffix()
  let n = 0

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  const user = async (label: string): Promise<TestUser> => {
    const name = `rw${label}${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  const createProject = (u: TestUser, name: string) => req(u.jar, 'POST', '/api/projects', { name: `${name} ${suffix}${n++}` })
  const xpOf = async (u: TestUser) => (await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).xp
  const xpEventTotal = async (u: TestUser) => (await testPrisma.xPEvent.aggregate({ where: { userId: u.userId }, _sum: { amount: true } }))._sum.amount ?? 0

  it('returns the envelope for the first project: XP, the achievement, no level change', async () => {
    const u = await user('first')
    const res = await createProject(u, 'First')
    expect(res.status).toBe(201)
    expect(res.data.name).toContain('First')
    expect(res.data.rewards).toEqual({
      xpGained: 75, // 50 for the project, 25 for First Project
      totalXp: 75,
      oldLevel: 1,
      newLevel: 1,
      leveledUp: false,
      oldTier: 'BRONZE',
      newTier: 'BRONZE',
      tierChanged: false,
      achievements: [{ slug: 'first-project', name: 'First Project' }],
      questsCompleted: [],
      streak: null,
    })
    expect(await xpOf(u)).toBe(75)
    expect(await xpEventTotal(u)).toBe(75)
  })

  it('stores what each award was for, with a key that identifies it', async () => {
    const u = await user('rows')
    const project = (await createProject(u, 'Rows')).data
    const rows = await testPrisma.xPEvent.findMany({ where: { userId: u.userId }, orderBy: { createdAt: 'asc' } })
    const created = rows.find((row) => row.type === 'PROJECT_CREATED')!
    expect(created).toMatchObject({ amount: 50, sourceType: 'PROJECT', sourceId: project.id, dedupeKey: `project:${project.id}`, seasonId: null })
    const achievement = rows.find((row) => row.type === 'ACHIEVEMENT_EARNED')!
    expect(achievement).toMatchObject({ amount: 25, sourceType: 'ACHIEVEMENT', sourceId: 'first-project', dedupeKey: 'achievement:first-project' })
  })

  it('always returns an envelope from a route that can award, with nothing earned when nothing was', async () => {
    const u = await user('quiet')
    const project = (await createProject(u, 'Quiet')).data
    const edit = await req(u.jar, 'PATCH', `/api/projects/${project.id}`, { description: 'just an edit' })
    expect(edit.status).toBe(200)
    expect(edit.data.rewards).toMatchObject({ xpGained: 0, totalXp: 75, leveledUp: false, tierChanged: false, achievements: [] })
  })

  it('pays only three project creations a day, so a create-and-delete loop cannot farm XP', async () => {
    const u = await user('loop')
    const gained: number[] = []
    for (let index = 0; index < 6; index++) {
      const created = await createProject(u, `Loop${index}`)
      expect(created.status).toBe(201)
      gained.push(created.data.rewards.xpGained)
      expect((await req(u.jar, 'DELETE', `/api/projects/${created.data.id}`)).status).toBe(200)
    }
    expect(gained).toEqual([75, 50, 50, 0, 0, 0])
    expect(await xpOf(u)).toBe(175)
    expect(await xpEventTotal(u)).toBe(175)
    expect(await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'PROJECT_CREATED' } })).toBe(3)
  })

  it('holds the cap when the creations arrive at the same time', async () => {
    const u = await user('race')
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => createProject(u, `Race${index}`)))
    expect(results.every((res) => res.status === 201)).toBe(true)
    expect(await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'PROJECT_CREATED' } })).toBe(3)
    expect(await xpOf(u)).toBe(await xpEventTotal(u))
    expect(await xpOf(u)).toBe(175)
    // What each response reports adds up to what was stored.
    expect(results.reduce((sum, res) => sum + res.data.rewards.xpGained, 0)).toBe(175)
  })

  it('pays shipping once per project, however many times it is shipped', async () => {
    const u = await user('ship')
    const project = (await createProject(u, 'Ship')).data
    const shipped = await req(u.jar, 'PATCH', `/api/projects/${project.id}`, { status: 'SHIPPED' })
    expect(shipped.status).toBe(200)
    expect(shipped.data.rewards).toMatchObject({
      xpGained: 300, // 200 for shipping, 100 for Shipped It
      totalXp: 375,
      oldLevel: 1,
      newLevel: 2,
      leveledUp: true,
      tierChanged: false,
    })
    expect(shipped.data.rewards.achievements).toEqual([{ slug: 'first-ship', name: 'Shipped It' }])

    for (const status of ['BUILDING', 'SHIPPED', 'BUILDING', 'SHIPPED']) {
      const again = await req(u.jar, 'PATCH', `/api/projects/${project.id}`, { status })
      expect(again.data.rewards.xpGained).toBe(0)
    }
    expect(await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'PROJECT_SHIP' } })).toBe(1)
    expect(await xpOf(u)).toBe(375)
  })

  it('reports each level-up and notifies the user once per level reached', async () => {
    const u = await user('level')
    const first = (await createProject(u, 'Level1')).data
    await req(u.jar, 'PATCH', `/api/projects/${first.id}`, { status: 'SHIPPED' }) // 375 XP: level 2
    const second = await createProject(u, 'Level2') // +50 = 425: level 3 starts at 383
    expect(second.data.rewards).toMatchObject({ xpGained: 50, totalXp: 425, oldLevel: 2, newLevel: 3, leveledUp: true })
    expect(levelFor(425).level).toBe(3)

    const notes = await testPrisma.notification.findMany({ where: { userId: u.userId, title: 'Level up!' }, orderBy: { createdAt: 'asc' } })
    expect(notes.map((note) => (note.metadata as { level: number }).level)).toEqual([2, 3])
  })

  it('reports a tier change when a level crosses into the next tier, and notifies for the level and the tier', async () => {
    const u = await user('tier')
    // Level 10 is where SILVER starts. Put the user 10 XP short of it.
    await testPrisma.user.update({ where: { id: u.userId }, data: { xp: xpAtLevelStart(10) - 10 } })
    const res = await createProject(u, 'Tier')
    expect(res.data.rewards).toMatchObject({ oldLevel: 9, newLevel: 10, leveledUp: true, oldTier: 'BRONZE', newTier: 'SILVER', tierChanged: true })

    const kinds = (await testPrisma.notification.findMany({ where: { userId: u.userId } })).map((note) => (note.metadata as { kind?: string }).kind)
    expect(kinds).toEqual(expect.arrayContaining(['LEVEL_UP', 'TIER_UP', 'ACHIEVEMENT_UNLOCKED']))
  })

  it('does not report a level-up one XP short of the threshold', async () => {
    const u = await user('short')
    // 50 for the project and 25 for the achievement take the user to start - 1.
    await testPrisma.user.update({ where: { id: u.userId }, data: { xp: xpAtLevelStart(2) - 1 - 75 } })
    const res = await createProject(u, 'Short')
    expect(res.data.rewards).toMatchObject({ totalXp: xpAtLevelStart(2) - 1, oldLevel: 1, newLevel: 1, leveledUp: false })
    expect(await testPrisma.notification.count({ where: { userId: u.userId, title: 'Level up!' } })).toBe(0)
  })

  it('tells the user about an unlocked achievement, once', async () => {
    const u = await user('unlock')
    await createProject(u, 'Unlock1')
    await createProject(u, 'Unlock2')
    const notes = await testPrisma.notification.findMany({ where: { userId: u.userId, title: 'Achievement unlocked' } })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ type: 'ACHIEVEMENT', message: 'First Project' })
  })

  it('records product events after the action commits, with no personal data', async () => {
    const u = await user('events')
    const project = (await createProject(u, 'Events')).data
    await req(u.jar, 'PATCH', `/api/projects/${project.id}`, { status: 'SHIPPED' })
    // Events are written just after the response is built; give them a moment.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const events = await testPrisma.productEvent.findMany({ where: { userId: u.userId }, orderBy: { createdAt: 'asc' } })
    const names = events.map((event) => event.name)
    expect(names).toEqual(expect.arrayContaining(['project_created', 'project_shipped', 'achievement_earned', 'level_up']))
    expect(events.find((event) => event.name === 'project_created')!.props).toEqual({ projectId: project.id })
    for (const event of events) {
      const text = JSON.stringify(event.props)
      expect(text).not.toContain('@')
      expect(text).not.toContain(project.name)
    }
  })

  describe('with the engine called directly', () => {
    // The engine, run the way a route runs it: in a transaction the event bus knows about.
    async function engine() {
      const { grant } = await import('../../src/lib/rewards')
      const { transactWithEvents } = await import('../../src/lib/events')
      type Tx = Parameters<Parameters<typeof testPrisma.$transaction>[0]>[0]
      const inTransaction = async <T,>(fn: (tx: Tx) => Promise<T>): Promise<T> => (await transactWithEvents(testPrisma, fn)).value
      return { grant, inTransaction }
    }

    it('awards once when many requests race for the same award', async () => {
      const { grant, inTransaction } = await engine()
      const u = await user('conc')
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          inTransaction((tx) => grant(tx, u.userId, 'HACKATHON_JOIN', { sourceType: 'HACKATHON', sourceId: `h-${suffix}`, description: 'Joined' }))
        )
      )
      expect(results.filter((result) => result.granted)).toHaveLength(1)
      expect(results.filter((result) => !result.granted && result.reason === 'DUPLICATE')).toHaveLength(11)
      expect(await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'HACKATHON_JOIN' } })).toBe(1)
      expect(await xpOf(u)).toBe(100)
    })

    it('adds up awards from different sources that arrive at the same time', async () => {
      const { grant, inTransaction } = await engine()
      const u = await user('sum')
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          inTransaction((tx) => grant(tx, u.userId, 'HACKATHON_JOIN', { sourceType: 'HACKATHON', sourceId: `h-${suffix}-${index}`, description: 'Joined' }))
        )
      )
      expect(await xpOf(u)).toBe(800)
      expect(await xpEventTotal(u)).toBe(800)
    })

    it('leaves nothing behind when the surrounding transaction rolls back', async () => {
      const { grant, inTransaction } = await engine()
      const u = await user('rollback')
      await expect(
        inTransaction(async (tx) => {
          await grant(tx, u.userId, 'HACKATHON_JOIN', { sourceType: 'HACKATHON', sourceId: `h-${suffix}-rb`, description: 'Joined' })
          throw new Error('the action failed afterwards')
        })
      ).rejects.toThrow()
      expect(await xpOf(u)).toBe(0)
      expect(await testPrisma.xPEvent.count({ where: { userId: u.userId } })).toBe(0)
    })

    // Three project awards were made at 10:00 UTC. For each zone, ask one second before and at its next midnight.
    const awardedAt = new Date('2026-03-10T10:00:00Z')
    it.each([
      ['UTC', '2026-03-10T23:59:59Z', '2026-03-11T00:00:00Z'],
      ['Asia/Kolkata', '2026-03-10T18:29:59Z', '2026-03-10T18:30:00Z'],
      ['America/New_York', '2026-03-11T03:59:59Z', '2026-03-11T04:00:00Z'],
      ['Pacific/Kiritimati', '2026-03-11T09:59:59Z', '2026-03-11T10:00:00Z'],
      ['Pacific/Pago_Pago', '2026-03-10T10:59:59Z', '2026-03-10T11:00:00Z'],
    ])('resets the daily cap at local midnight in %s', async (timezone, before, after) => {
      const { grant, inTransaction } = await engine()
      const u = await user(`tz${timezone.slice(-4).replace(/\W/g, '')}`)
      await testPrisma.user.update({ where: { id: u.userId }, data: { timezone } })
      await testPrisma.xPEvent.createMany({
        data: ['a', 'b', 'c'].map((id) => ({
          userId: u.userId,
          type: 'PROJECT_CREATED',
          amount: 50,
          description: 'seed',
          sourceType: 'PROJECT',
          sourceId: id,
          dedupeKey: `project:${id}`,
          createdAt: awardedAt,
        })),
      })
      const award = (id: string, now: string) =>
        inTransaction((tx) => grant(tx, u.userId, 'PROJECT_CREATED', { sourceType: 'PROJECT', sourceId: id, description: 'x', now: new Date(now) }))

      expect(await award('d', before)).toMatchObject({ granted: false, reason: 'DAILY_CAP' })
      expect((await award('e', after)).granted).toBe(true)
    })

    it('gives two people in different zones different days at the same instant', async () => {
      const { grant, inTransaction } = await engine()
      const london = await user('lon')
      const kolkata = await user('kol')
      await testPrisma.user.update({ where: { id: london.userId }, data: { timezone: 'Europe/London' } })
      await testPrisma.user.update({ where: { id: kolkata.userId }, data: { timezone: 'Asia/Kolkata' } })
      for (const u of [london, kolkata]) {
        await testPrisma.xPEvent.createMany({
          data: ['a', 'b', 'c'].map((id) => ({
            userId: u.userId, type: 'PROJECT_CREATED', amount: 50, description: 'seed', sourceType: 'PROJECT', sourceId: id, dedupeKey: `project:${id}`, createdAt: awardedAt,
          })),
        })
      }
      const now = new Date('2026-03-10T20:00:00Z') // still the 10th in London, already the 11th in Kolkata
      const ask = (u: TestUser) => inTransaction((tx) => grant(tx, u.userId, 'PROJECT_CREATED', { sourceType: 'PROJECT', sourceId: 'd', description: 'x', now }))
      expect((await ask(london)).granted).toBe(false)
      expect((await ask(kolkata)).granted).toBe(true)
    })

    it('falls back to UTC for a user without a time zone', async () => {
      const { grant, inTransaction } = await engine()
      const u = await user('notz')
      await testPrisma.xPEvent.createMany({
        data: ['a', 'b', 'c'].map((id) => ({
          userId: u.userId, type: 'PROJECT_CREATED', amount: 50, description: 'seed', sourceType: 'PROJECT', sourceId: id, dedupeKey: `project:${id}`, createdAt: awardedAt,
        })),
      })
      const ask = (now: string) => inTransaction((tx) => grant(tx, u.userId, 'PROJECT_CREATED', { sourceType: 'PROJECT', sourceId: now, description: 'x', now: new Date(now) }))
      expect((await ask('2026-03-10T23:59:59Z')).granted).toBe(false)
      expect((await ask('2026-03-11T00:00:00Z')).granted).toBe(true)
    })
  })
})
