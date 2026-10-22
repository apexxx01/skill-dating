import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, reconcileLeaderboards, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { joinCampus, removeCampuses } from './campus-fixtures'

const DAY_MS = 24 * 60 * 60 * 1000

// The leaderboards through the real routes: periods and scopes, ranks that are absolute (blocked people are left out, never renumbered)
// (blocks), rank cursors, the viewer's standing and the people around them, privacy, and the rebuild from the log.
describe('leaderboards v2', () => {
  const suffix = uniqueSuffix().toLowerCase()
  let n = 0
  let operator: TestUser
  afterAll(async () => {
    await cleanupTestUsers(suffix)
    await removeCampuses([`campus-${suffix}-a`, `first-${suffix}`, `second-${suffix}`, `shared-${suffix}`, `typed-${suffix}`])
  }, 300_000)
  beforeAll(async () => {
    const name = `lbop${suffix}`
    operator = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(operator.userId)
  })

  const user = async (): Promise<TestUser> => {
    const name = `lb${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  const board = (u: TestUser, query = '') => req(u.jar, 'GET', `/api/leaderboard${query}`)
  /** Writes XP straight into the log (so a rebuild is needed to see it on a board). */
  const logXp = (userId: string, amount: number, over: { daysAgo?: number; seasonId?: string | null } = {}) =>
    testPrisma.xPEvent.create({
      data: {
        userId,
        type: 'PROJECT_CREATED',
        amount,
        description: 'seed',
        sourceType: 'TEST',
        sourceId: `${n++}`,
        dedupeKey: `test:${n}:${Math.random()}`,
        seasonId: over.seasonId ?? null,
        createdAt: new Date(Date.now() - (over.daysAgo ?? 0) * DAY_MS),
      },
    })
  const rebuild = () => reconcileLeaderboards(operator.jar)
  const ids = (res: { data: { entries: { user: { id: string } }[] } }) => res.data.entries.map((entry) => entry.user.id)
  const eventually = async (check: () => Promise<boolean>, what: string, timeoutMs = 15_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`timed out waiting for: ${what}`)
  }

  describe('the request', () => {
    it('needs a signed-in user and a valid query', async () => {
      expect((await req(null, 'GET', '/api/leaderboard')).status).toBe(401)
      const u = await user()
      for (const query of ['?period=yearly', '?scope=planet', '?limit=0', '?limit=101', '?page=0', '?limit=abc', '?scope=country&scopeId=XX', '?scope=city&scopeId=pune', '?scope=crew&scopeId=bad%20id']) {
        const res = await board(u, query)
        expect(res.status, query).toBe(400)
        expect(res.data.error.code, query).toBe('VALIDATION_FAILED')
      }
      const cursor = await board(u, '?cursor=nope')
      expect(cursor.status).toBe(400)
      expect(cursor.data.error.code).toBe('INVALID_CURSOR')
    })

    it('defaults to the all-time global board and says what it is showing', async () => {
      const u = await user()
      const res = await board(u)
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ period: 'all-time', scope: { type: 'global', id: null }, season: null, myScopes: { country: null, city: null, campus: null } })
      expect(res.data.me).toEqual({ rank: null, score: 0, xp: 0, hidden: false })
      expect(res.data.around).toEqual([])
    })
  })

  describe('periods', () => {
    it('puts XP earned now on the weekly, monthly, season and all-time boards, at the same score', async () => {
      const u = await user()
      const created = await req(u.jar, 'POST', '/api/projects', { name: `Lb ${suffix}${n++}` })
      expect(created.status).toBe(201)
      for (const period of ['weekly', 'monthly', 'season', 'all-time']) {
        const res = await board(u, `?period=${period}&limit=100`)
        expect(res.status, period).toBe(200)
        expect(res.data.period).toBe(period)
        expect(res.data.me.score, period).toBe(75)
        expect(res.data.me.rank, period).toBeGreaterThanOrEqual(1)
        expect(ids(res), period).toContain(u.userId)
      }
      const season = await board(u, '?period=season')
      expect(season.data.season).toMatchObject({ number: expect.any(Number), name: expect.stringMatching(/^Season \d+$/) })
      expect(new Date(season.data.season.endsAt).getTime()).toBeGreaterThan(Date.now() - 1000)
    })

    it('counts XP from before this week or season only on the boards of the periods it belongs to', async () => {
      const u = await user()
      await logXp(u.userId, 5_000_000, { daysAgo: 400 }) // long ago, no season
      await rebuild()
      expect((await board(u, '?period=all-time')).data.me.score).toBe(5_000_000)
      for (const period of ['weekly', 'monthly', 'season']) expect((await board(u, `?period=${period}`)).data.me).toMatchObject({ rank: null, score: 0 })
    })

    it('puts XP stamped with the active season on the season board, and not XP stamped with none', async () => {
      const u = await user()
      const season = await testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
      await logXp(u.userId, 70_000, { seasonId: season.id })
      await logXp(u.userId, 40_000) // no season
      await rebuild()
      expect((await board(u, '?period=season')).data.me.score).toBe(70_000)
      expect((await board(u, '?period=all-time')).data.me.score).toBe(110_000)
    })
  })

  describe('ranks', () => {
    it('order people by score, and the viewer sees their own standing and the people around them', async () => {
      const people = [await user(), await user(), await user(), await user(), await user(), await user(), await user()]
      const scores = [9_000_100, 9_000_090, 9_000_080, 9_000_070, 9_000_060, 9_000_050, 9_000_040]
      for (const [index, person] of people.entries()) await logXp(person.userId, scores[index])
      await rebuild()

      const me = people[3]
      const res = await board(me, '?limit=100')
      const order = ids(res).filter((id) => people.some((p) => p.userId === id))
      expect(order).toEqual(people.map((p) => p.userId))
      expect(res.data.me.score).toBe(9_000_070)
      expect(res.data.around).toHaveLength(5)
      expect(res.data.around.map((entry: { user: { id: string } }) => entry.user.id)).toEqual(people.slice(1, 6).map((p) => p.userId))
      const ranks = res.data.around.map((entry: { rank: number }) => entry.rank)
      expect(ranks).toEqual(ranks.map((_: number, index: number) => ranks[0] + index))
      expect(ranks[2]).toBe(res.data.me.rank)

      // At the top of the whole board there is nobody above to show.
      const top = await board(people[0], '?limit=100')
      expect(top.data.around.map((entry: { rank: number }) => entry.rank)).toEqual([top.data.me.rank, top.data.me.rank + 1, top.data.me.rank + 2])
    })

    it('carries a level and tier on each row', async () => {
      const u = await user()
      await logXp(u.userId, 8_000_000)
      await rebuild()
      const res = await board(u, '?limit=5')
      expect(res.data.entries[0]).toMatchObject({ rank: 1, score: expect.any(Number), level: expect.any(Number), tier: expect.stringMatching(/^(BRONZE|SILVER|GOLD|PLATINUM|DIAMOND|MYTHIC)$/) })
    })
  })

  describe('rank cursors', () => {
    it('continue exactly where the page ended, with consecutive ranks and no count', async () => {
      const people = [await user(), await user(), await user(), await user(), await user()]
      for (const [index, person] of people.entries()) await logXp(person.userId, 20_000_000 - index * 10)
      await rebuild()

      const viewer = people[4]
      const first = await board(viewer, '?limit=2')
      expect(first.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([1, 2])
      expect(first.data.nextCursor).not.toBeNull()
      expect(first.data.pagination).toBeDefined()
      const second = await board(viewer, `?limit=2&cursor=${first.data.nextCursor}`)
      expect(second.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([3, 4])
      expect(second.data.pagination).toBeUndefined()
      const seen = [...ids(first), ...ids(second)]
      expect(new Set(seen).size).toBe(4)
      expect(seen.slice(0, 4).filter((id) => people.some((p) => p.userId === id)).length).toBeGreaterThanOrEqual(4)
    })

    it('follow the last person of the page if they were overtaken before the next page was read', async () => {
      const people = [await user(), await user(), await user(), await user()]
      const base = 30_000_000
      for (const [index, person] of people.entries()) await logXp(person.userId, base - index * 100)
      await rebuild()
      const viewer = people[3]

      const first = await board(viewer, '?limit=2')
      const lastOfFirst = first.data.entries[1].user.id
      expect(lastOfFirst).toBe(people[1].userId)

      // The third person overtakes everybody before the next page is asked for.
      await logXp(people[2].userId, 500)
      await rebuild()
      const everyone = await board(viewer, '?limit=100')
      const rankOfLast = everyone.data.entries.find((entry: { user: { id: string } }) => entry.user.id === lastOfFirst).rank

      const second = await board(viewer, `?limit=2&cursor=${first.data.nextCursor}`)
      // The page starts right after the person the last page ended with, wherever they are now: nobody is shown twice.
      expect(second.data.entries[0].rank).toBe(rankOfLast + 1)
      expect(ids(second)).not.toContain(lastOfFirst)
      expect(ids(second)).not.toContain(people[0].userId)
      expect(ids(second)).not.toContain(people[2].userId)
      expect(ids(second)).toContain(people[3].userId)
    })

    it('end with a null cursor on the last page', async () => {
      const u = await user()
      await logXp(u.userId, 1)
      await rebuild()
      let cursor: string | null | undefined
      let pages = 0
      do {
        const res = await board(u, `?limit=100${cursor ? `&cursor=${cursor}` : ''}`)
        expect(res.status).toBe(200)
        cursor = res.data.nextCursor
        pages += 1
      } while (cursor && pages < 50)
      expect(cursor).toBeNull()
    })
  })

  describe('blocks', () => {
    it('hide each of two people from the other, and leave every rank where it is: the same number for everybody', async () => {
      const a = await user()
      const b = await user()
      const c = await user()
      await logXp(a.userId, 40_000_300)
      await logXp(b.userId, 40_000_200)
      await logXp(c.userId, 40_000_100)
      await rebuild()

      const before = await board(c, '?limit=100')
      const rankBefore = before.data.me.rank
      expect(ids(before)).toEqual(expect.arrayContaining([a.userId, b.userId, c.userId]))

      await req(a.jar, 'POST', '/api/blocks', { userId: b.userId })
      const asA = await board(a, '?limit=100')
      expect(ids(asA)).not.toContain(b.userId)
      const asB = await board(b, '?limit=100')
      expect(ids(asB)).not.toContain(a.userId)
      const rankOf = (res: { data: { entries: { rank: number; user: { id: string } }[] } }, id: string) => res.data.entries.find((entry) => entry.user.id === id)?.rank
      const everyone = await board(c, '?limit=100')
      // Nobody moves up because somebody was blocked: A and C have the rank they have for everybody else.
      expect(rankOf(asA, a.userId)).toBe(rankOf(everyone, a.userId))
      expect(rankOf(asA, c.userId)).toBe(rankOf(everyone, c.userId))
      expect(rankOf(asB, b.userId)).toBe(rankOf(everyone, b.userId))
      expect(rankOf(asB, c.userId)).toBe(rankOf(everyone, c.userId))
      // So A's list has a gap where B was.
      expect(rankOf(asA, c.userId)! - rankOf(asA, a.userId)!).toBe(2)
      // A third person is unaffected, and A's own rank is the same number everywhere.
      expect((await board(c, '?limit=100')).data.me.rank).toBe(rankBefore)
      expect(asA.data.me.rank).toBe(rankOf(everyone, a.userId))
      expect(asA.data.around.map((entry: { user: { id: string } }) => entry.user.id)).not.toContain(b.userId)
      expect(asA.data.pagination.total).toBe(before.data.pagination.total)
      // The player card shows that same number.
      const card = await req(a.jar, 'GET', `/api/users/${c.userId}/stats`)
      expect(card.data.ranks.global).toBe(rankOf(asA, c.userId))
    })
  })

  describe('places', () => {
    it('puts a person on the board of their campus and city once they say where they are, and not before', async () => {
      const u = await user()
      const other = await user()
      const campus = `Campus ${suffix} A`
      await req(u.jar, 'POST', '/api/projects', { name: `Place ${suffix}${n++}` })
      await req(other.jar, 'POST', '/api/projects', { name: `Place ${suffix}${n++}` })

      // No campus set: the campus board has nobody to show and the viewer has no default.
      const none = await board(u, '?scope=campus')
      expect(none.status).toBe(400)
      expect(none.data.error.details.scopeId[0]).toMatch(/campus/)

      // Typing a campus is not enough to be on its board: a campus is verified (campus-fixtures.ts joins one the way verifying an e-mail address leaves a person).
      expect((await req(u.jar, 'PATCH', '/api/users/me/profile', { campus: `Typed ${suffix}`, countryCode: 'IN', city: `Pune ${suffix}` })).status).toBe(200)
      await eventually(async () => ids(await board(u, '?scope=city')).includes(u.userId), 'the person to appear on their city board')
      expect((await board(u, '?scope=campus')).status).toBe(400)
      expect(ids(await board(other, `?scope=campus&scopeId=typed-${suffix}`))).toEqual([])
      await joinCampus(u.userId, campus)
      await rebuild()
      const campusBoard = await board(u, '?scope=campus')
      expect(campusBoard.data.scope).toEqual({ type: 'campus', id: `campus-${suffix}-a` })
      expect(campusBoard.data.me).toMatchObject({ rank: 1, score: 75 })
      expect(ids(campusBoard)).toEqual([u.userId])
      expect(campusBoard.data.myScopes).toEqual({ country: 'IN', city: `IN:pune-${suffix}`, campus: `campus-${suffix}-a` })

      const city = await board(u, '?scope=city')
      expect(city.data.scope).toEqual({ type: 'city', id: `IN:pune-${suffix}` })
      expect(ids(city)).toEqual([u.userId])
      // Somebody who named no campus is not on it, and is told to say which one they mean.
      expect(ids(await board(other, `?scope=campus&scopeId=${encodeURIComponent(campus)}`))).toEqual([u.userId])
      expect((await board(other, '?scope=campus')).status).toBe(400)
    })

    it('forgives case in a country, and ranks the country among its own people', async () => {
      const a = await user()
      const b = await user()
      for (const u of [a, b]) await req(u.jar, 'PATCH', '/api/users/me/profile', { countryCode: 'NZ' })
      await logXp(a.userId, 50_000_100)
      await logXp(b.userId, 50_000_200)
      await rebuild()
      const res = await board(a, '?scope=country&scopeId=nz&limit=100')
      expect(res.data.scope).toEqual({ type: 'country', id: 'NZ' })
      const order = ids(res).filter((id) => [a.userId, b.userId].includes(id))
      expect(order).toEqual([b.userId, a.userId])
    })

    it('moves a person off the old board and onto the new one when they change campus', async () => {
      const u = await user()
      await req(u.jar, 'POST', '/api/projects', { name: `Move ${suffix}${n++}` })
      await joinCampus(u.userId, `First ${suffix}`)
      await rebuild()
      expect(ids(await board(u, `?scope=campus&scopeId=first-${suffix}`))).toContain(u.userId)
      // Leaving is the real route, which tells the boards where the person was so the old one is cleared.
      expect((await req(u.jar, 'DELETE', '/api/campus/me')).status).toBe(200)
      await eventually(async () => !ids(await board(u, `?scope=campus&scopeId=first-${suffix}`)).includes(u.userId), 'to leave the first campus')
      await joinCampus(u.userId, `Second ${suffix}`)
      await rebuild()
      expect(ids(await board(u, `?scope=campus&scopeId=second-${suffix}`))).toContain(u.userId)
      expect(ids(await board(u, `?scope=campus&scopeId=first-${suffix}`))).not.toContain(u.userId)
    })

    it('gives a campus board the people of that campus only', async () => {
      const members = [await user(), await user()]
      const outsider = await user()
      for (const [index, member] of members.entries()) {
        await joinCampus(member.userId, `Shared ${suffix}`)
        await logXp(member.userId, 60_000_000 + index)
      }
      await logXp(outsider.userId, 99_000_000)
      await rebuild()
      const res = await board(members[0], '?scope=campus&limit=100')
      expect(ids(res)).toEqual([members[1].userId, members[0].userId])
      expect(res.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([1, 2])
    })
  })

  describe('crews', () => {
    it('ranks the members of a team by their XP, summed from the log', async () => {
      const lead = await user()
      const member = await user()
      const outsider = await user()
      const team = await req(lead.jar, 'POST', '/api/teams', { name: `Crew ${suffix}${n++}` })
      expect(team.status).toBe(201)
      await testPrisma.teamMember.upsert({ where: { userId_teamId: { userId: member.userId, teamId: team.data.id } }, create: { userId: member.userId, teamId: team.data.id, role: 'MEMBER' }, update: {} })
      await logXp(lead.userId, 100)
      await logXp(member.userId, 300)
      await logXp(outsider.userId, 10_000)

      const res = await board(lead, `?scope=crew&scopeId=${team.data.id}`)
      expect(res.status).toBe(200)
      expect(res.data.scope).toEqual({ type: 'crew', id: team.data.id })
      expect(res.data.entries.map((entry: { user: { id: string }; rank: number; score: number }) => [entry.rank, entry.user.id, entry.score])).toEqual([
        [1, member.userId, 300],
        [2, lead.userId, 100],
      ])
      expect(res.data.me).toMatchObject({ rank: 2, score: 100 })
      // Anyone signed in can look at a crew; a time period narrows what is summed.
      expect((await board(outsider, `?scope=crew&scopeId=${team.data.id}&period=all-time`)).status).toBe(200)
      await logXp(member.userId, 5, { daysAgo: 400 })
      expect((await board(lead, `?scope=crew&scopeId=${team.data.id}&period=weekly`)).data.entries).toHaveLength(2)
    })

    it('needs the crew named, and answers 404 for one that does not exist', async () => {
      const u = await user()
      expect((await board(u, '?scope=crew')).status).toBe(400)
      const missing = await board(u, '?scope=crew&scopeId=doesnotexist1')
      expect(missing.status).toBe(404)
      expect(missing.data.error.code).toBe('TEAM_NOT_FOUND')
    })
  })

  describe('privacy', () => {
    it('takes a person who opts out off every board and brings them back when they opt in', async () => {
      const u = await user()
      const viewer = await user()
      await req(u.jar, 'POST', '/api/projects', { name: `Private ${suffix}${n++}` })
      expect(ids(await board(viewer, '?limit=100'))).toContain(u.userId)

      expect((await req(u.jar, 'PATCH', '/api/users/me/profile', { hideFromLeaderboards: true })).status).toBe(200)
      await eventually(async () => !ids(await board(viewer, '?limit=100')).includes(u.userId), 'to leave the global board')
      const own = await board(u)
      expect(own.data.me).toEqual({ rank: null, score: 0, xp: 0, hidden: true })
      expect(own.data.around).toEqual([])
      // Earning more while hidden does not put them back.
      await req(u.jar, 'POST', '/api/projects', { name: `Private ${suffix}${n++}` })
      expect(ids(await board(viewer, '?limit=100'))).not.toContain(u.userId)
      // Nor does a rebuild.
      await rebuild()
      expect(ids(await board(viewer, '?limit=100'))).not.toContain(u.userId)

      expect((await req(u.jar, 'PATCH', '/api/users/me/profile', { hideFromLeaderboards: false })).status).toBe(200)
      await eventually(async () => ids(await board(viewer, '?limit=100')).includes(u.userId), 'to come back')
      expect((await board(u)).data.me).toMatchObject({ hidden: false, score: 75 + 50 })
    })
  })

  describe('the rebuild from the log', () => {
    it('repairs a board that missed an award, and drops the people it should not hold', async () => {
      const u = await user()
      const gone = await user()
      await req(u.jar, 'POST', '/api/projects', { name: `Repair ${suffix}${n++}` })
      await logXp(u.userId, 70_000_000) // behind the engine's back
      await logXp(gone.userId, 80_000_000)
      await testPrisma.user.update({ where: { id: gone.userId }, data: { deletedAt: new Date() } })

      const stale = await board(u)
      expect(stale.data.me.score).toBe(75)

      const run = await req(operator.jar, 'POST', '/api/admin/jobs/leaderboards/reconcile')
      expect(run.status).toBe(200)
      expect(run.data.result).toMatchObject({ periods: 4 })
      expect(run.data.result.boards).toBeGreaterThan(0)

      const fixed = await board(u, '?limit=100')
      expect(fixed.data.me.score).toBe(70_000_075)
      expect(ids(fixed)).not.toContain(gone.userId)
    })

    it('is for admins only', async () => {
      const u = await user()
      expect((await req(u.jar, 'POST', '/api/admin/jobs/leaderboards/reconcile')).status).toBe(403)
    })

    it('can be run again and again without changing the result', async () => {
      const u = await user()
      await logXp(u.userId, 12_345)
      await rebuild()
      const first = (await board(u)).data.me
      await rebuild()
      await rebuild()
      expect((await board(u)).data.me).toEqual(first)
    })
  })
})
