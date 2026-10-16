import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'

const DAY_MS = 24 * 60 * 60 * 1000

// The season rollover job and the admin route that runs jobs on demand.
describe('background jobs on demand, and the season rollover', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let admin: TestUser

  beforeAll(async () => {
    const name = `sa${suffix}`
    admin = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(admin.userId)
  })
  afterAll(() => cleanupTestUsers(suffix), 180_000)

  const run = (name: string, data?: unknown, jar = admin.jar) => req(jar, 'POST', `/api/admin/jobs/${name}`, data === undefined ? undefined : { data })
  /** A user with XP in the log, as a row stamped with the given season. */
  async function scorer(seasonId: string, amounts: number[], over: { hidden?: boolean; deleted?: boolean } = {}) {
    const name = `sc${suffix}${n++}`
    const user = await testPrisma.user.create({ data: { email: `${name}@test.dev`, username: name, name, ...(over.deleted ? { deletedAt: new Date() } : {}) } })
    if (over.hidden) await testPrisma.profile.create({ data: { userId: user.id, hideFromLeaderboards: true } })
    for (const amount of amounts) {
      await testPrisma.xPEvent.create({ data: { userId: user.id, type: 'TEST', amount, description: 'test', seasonId, dedupeKey: `t:${n++}:${Math.random()}` } })
    }
    return user
  }

  describe('POST /api/admin/jobs/...', () => {
    it('is for admins only', async () => {
      const name = `sn${suffix}`
      const plain = await registerAndLogin(`${name}@test.dev`, name)
      expect((await run('system/ping', undefined, plain.jar)).status).toBe(403)
      expect((await req(null, 'POST', '/api/admin/jobs/system/ping')).status).toBe(401)
    })

    it('runs a job and answers with its result; no body means its defaults', async () => {
      const res = await run('system/ping')
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ name: 'system/ping', result: { pong: true, note: null } })
      expect(typeof res.data.durationMs).toBe('number')
      const withNote = await run('system/ping', { note: 'hello' })
      expect(withNote.data.result).toEqual({ pong: true, note: 'hello' })
      expect(await testPrisma.auditEvent.count({ where: { userId: admin.userId, action: 'JOB_RUN', targetId: 'system/ping' } })).toBe(2)
    })

    it('answers 404 for a job that does not exist, and validates the payload with the job schema', async () => {
      const missing = await run('nope/nothing')
      expect(missing.status).toBe(404)
      expect(missing.data.error.code).toBe('JOB_NOT_FOUND')
      expect((await run('constructor')).status).toBe(404)
      expect((await run('__proto__')).status).toBe(404)
      const bad = await req(admin.jar, 'POST', '/api/admin/jobs/system/ping', { data: { note: 12 } })
      expect(bad.status).toBeGreaterThanOrEqual(400)
      expect((await req(admin.jar, 'POST', '/api/admin/jobs/system/ping', { data: 'x' })).status).toBe(400)
    })
  })

  describe('seasons/rollover', () => {
    async function active() {
      return testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
    }
    const endNow = (id: string, endsAt: Date) => testPrisma.season.update({ where: { id }, data: { endsAt } })

    it('does nothing while the season is still running', async () => {
      const season = await active()
      await endNow(season.id, new Date(Date.now() + 5 * DAY_MS))
      const res = await run('seasons/rollover')
      expect(res.status).toBe(200)
      expect(res.data.result).toEqual({ closed: false })
      expect((await active()).id).toBe(season.id)
    })

    it('closes a finished season: final standings written once, in the live order, with the next season opened', async () => {
      const season = await active()
      const endsAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await endNow(season.id, endsAt)
      const first = await scorer(season.id, [300, 200]) // 500
      const second = await scorer(season.id, [400]) // 400
      const tieA = await scorer(season.id, [100])
      const tieB = await scorer(season.id, [100])
      const hidden = await scorer(season.id, [9000], { hidden: true })
      const gone = await scorer(season.id, [9000], { deleted: true })
      const zero = await scorer(season.id, [50, -50])
      // XP from another season is not part of this one.
      const other = await testPrisma.season.create({ data: { number: 900 + n++, name: 'Other', startsAt: new Date(0), endsAt: new Date(1), active: false } })
      const elsewhere = await scorer(other.id, [10_000])

      const res = await run('seasons/rollover')
      expect(res.status).toBe(200)
      expect(res.data.result).toMatchObject({ closed: true, seasonId: season.id, seasonNumber: season.number, opened: { number: season.number + 1 } })

      const closed = await testPrisma.season.findUniqueOrThrow({ where: { id: season.id } })
      expect(closed.active).toBe(false)
      expect(closed.closedAt).not.toBeNull()

      const mine = [first, second, tieA, tieB, hidden, gone, zero, elsewhere].map((u) => u.id)
      const standings = (await testPrisma.seasonStanding.findMany({ where: { seasonId: season.id, userId: { in: mine } }, orderBy: { rank: 'asc' } })).map((row) => ({ userId: row.userId, score: row.score }))
      // Score first; a tie goes to the larger user id, the order Redis keeps for the live boards.
      const [tieHigh, tieLow] = [tieA.id, tieB.id].sort().reverse()
      expect(standings).toEqual([
        { userId: first.id, score: 500 },
        { userId: second.id, score: 400 },
        { userId: tieHigh, score: 100 },
        { userId: tieLow, score: 100 },
      ])
      const ranks = (await testPrisma.seasonStanding.findMany({ where: { seasonId: season.id }, orderBy: { rank: 'asc' } })).map((row) => row.rank)
      expect(ranks).toEqual(ranks.map((_, index) => index + 1))

      // The next season starts where this one stopped and lasts eight weeks.
      const next = await active()
      expect(next.number).toBe(season.number + 1)
      expect(next.startsAt.toISOString()).toBe(endsAt.toISOString())
      expect((next.endsAt.getTime() - next.startsAt.getTime()) / DAY_MS).toBe(56)
      expect(next.name).toBe(`Season ${next.number}`)

      // And new XP is stamped with it.
      const name = `sc${suffix}${n++}`
      const u = await registerAndLogin(`${name}@test.dev`, name)
      await req(u.jar, 'POST', '/api/projects', { name: `After ${suffix}` })
      const stamped = await testPrisma.xPEvent.findMany({ where: { userId: u.userId } })
      expect(stamped.length).toBeGreaterThan(0)
      for (const event of stamped) expect(event.seasonId).toBe(next.id)
    })

    it('does not close the same season twice, however often or concurrently it runs', async () => {
      const season = await active()
      await endNow(season.id, new Date(Date.now() - 60_000))
      await scorer(season.id, [10])
      const results = await Promise.all([run('seasons/rollover'), run('seasons/rollover'), run('seasons/rollover')])
      expect(results.map((res) => res.status)).toEqual([200, 200, 200])
      expect(results.filter((res) => res.data.result.closed)).toHaveLength(1)
      const standings = await testPrisma.seasonStanding.findMany({ where: { seasonId: season.id } })
      expect(new Set(standings.map((row) => row.userId)).size).toBe(standings.length)
      expect(await testPrisma.season.count({ where: { active: true } })).toBe(1)
      expect((await run('seasons/rollover')).data.result).toEqual({ closed: false })
    })

    it('opens the next season from now when the job was down for longer than a season', async () => {
      const season = await active()
      const before = Date.now()
      await endNow(season.id, new Date(before - 100 * DAY_MS))
      const res = await run('seasons/rollover')
      expect(res.data.result.closed).toBe(true)
      const next = await active()
      expect(next.startsAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(next.endsAt.getTime()).toBeGreaterThan(Date.now() + 55 * DAY_MS)
    })

    it('leaves one season running at the end', async () => {
      expect(await testPrisma.season.count({ where: { active: true } })).toBe(1)
    })
  })
})
