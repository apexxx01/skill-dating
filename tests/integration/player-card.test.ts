import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, reconcileLeaderboards, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { levelFor } from '../../src/lib/levels'

// GET /api/users/{id}/stats: the player card, in one call, cached for 60 seconds and refreshed by every award.
describe('player card', () => {
  const suffix = uniqueSuffix().toLowerCase()
  let n = 0
  let operator: TestUser
  afterAll(() => cleanupTestUsers(suffix), 240_000)
  beforeAll(async () => {
    const name = `pcop${suffix}`
    operator = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(operator.userId)
  })

  const user = async (): Promise<TestUser> => {
    const name = `pc${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  const card = (viewer: TestUser | null, userId: string) => req(viewer?.jar ?? null, 'GET', `/api/users/${userId}/stats`)
  const project = async (u: TestUser) => (await req(u.jar, 'POST', '/api/projects', { name: `Pc ${suffix}${n++}` })).data as { id: string }

  it('needs a signed-in user, and a user that exists', async () => {
    const u = await user()
    expect((await card(null, u.userId)).status).toBe(401)
    for (const id of ['nonexistent123', 'bad%20id']) {
      const res = await card(u, id)
      expect(res.status, id).toBe(404)
      expect(res.data.error.code).toBe('USER_NOT_FOUND')
    }
  })

  it('is a card of zeros for a new user', async () => {
    const u = await user()
    const res = await card(u, u.userId)
    expect(res.status).toBe(200)
    expect(res.data).toEqual({
      userId: u.userId,
      xp: 0,
      level: 1,
      tier: 'BRONZE',
      progress: { xpIntoLevel: 0, xpForNextLevel: 5, fraction: 0 },
      ranks: { global: null, country: null, city: null },
      equipped: { title: null, frame: null, banner: null, badges: [] },
      streak: { current: 0, longest: 0, freezes: 0, lastDay: null },
      topAchievements: [],
      counts: { shipped: 0, hackathons: 0, wins: 0, endorsementsReceived: 0, crews: 0, milestones: 0 },
    })
  })

  it('reports XP, level, tier, streak, counts and the rarest achievements after some real progress', async () => {
    const u = await user()
    const created = await project(u)
    expect((await req(u.jar, 'PATCH', `/api/projects/${created.id}`, { status: 'SHIPPED' })).status).toBe(200)

    const res = await card(u, u.userId)
    expect(res.data.xp).toBe(375)
    expect(res.data).toMatchObject({ level: levelFor(375).level, tier: 'BRONZE', counts: { shipped: 1 } })
    expect(res.data.progress.xpIntoLevel + 0).toBe(levelFor(375).xpIntoLevel)
    expect(res.data.streak).toMatchObject({ current: 1, longest: 1 })
    // The rarest first. (Whether the nightly job has run yet depends on what ran before; unknown rarities sort last.)
    const top = res.data.topAchievements as { slug: string; name: string; rarity: number | null }[]
    expect(top.map((item) => item.slug).sort()).toEqual(['first-project', 'first-ship'])
    const known = top.map((item) => item.rarity ?? 2)
    expect(known).toEqual([...known].sort((a, b) => a - b))
    expect(top.find((item) => item.slug === 'first-ship')).toMatchObject({ name: 'Shipped It' })
  })

  it('puts the rarest achievements first once the nightly job has computed rarity, three at most', async () => {
    const u = await user()
    for (let index = 0; index < 3; index++) {
      const p = await project(u)
      await req(u.jar, 'PATCH', `/api/projects/${p.id}`, { status: 'SHIPPED' })
    }
    // Earned: first-project, first-ship and, for three ships in a week, the secret Hat Trick.
    expect((await req(operator.jar, 'POST', '/api/admin/jobs/achievements/rarity')).status).toBe(200)
    // The cached card is up to 60 seconds old; an award retires it.
    await project(u)
    const res = await card(u, u.userId)
    expect(res.data.topAchievements).toHaveLength(3)
    const rarities = res.data.topAchievements.map((item: { rarity: number }) => item.rarity)
    expect(rarities).toEqual([...rarities].sort((a: number, b: number) => a - b))
    expect(res.data.topAchievements.map((item: { slug: string }) => item.slug)).toContain('hat-trick')
  })

  it('is cached for a minute and refreshed at once by an award', async () => {
    const u = await user()
    await project(u)
    const first = await card(u, u.userId)
    expect(first.data.xp).toBe(75)

    // Changed behind the engine's back: the cached card is served.
    await testPrisma.user.update({ where: { id: u.userId }, data: { xp: 4_000 } })
    expect((await card(u, u.userId)).data.xp).toBe(75)

    // An award goes through the engine, which throws the cached card away.
    await project(u)
    const fresh = await card(u, u.userId)
    expect(fresh.data.xp).toBe(4_000 + 50)
    expect(fresh.data.counts.shipped).toBe(0)
  })

  it('shows the place on the all-time boards: global, and the country and city once they are set', async () => {
    const u = await user()
    await project(u)
    await testPrisma.xPEvent.create({ data: { userId: u.userId, type: 'PROJECT_CREATED', amount: 3_000_000, description: 'seed', sourceType: 'TEST', sourceId: 'x', dedupeKey: `test:${Math.random()}` } })
    await req(u.jar, 'PATCH', '/api/users/me/profile', { countryCode: 'NZ', city: `Napier ${suffix}` })
    await reconcileLeaderboards(operator.jar)
    // Setting the place threw the cached card away; a second read after the rebuild has the ranks.
    await project(u)
    const res = await card(u, u.userId)
    expect(res.data.ranks.global).toBeGreaterThanOrEqual(1)
    expect(res.data.ranks.country).toBeGreaterThanOrEqual(1)
    expect(res.data.ranks.city).toBe(1)
    const board = await req(u.jar, 'GET', '/api/leaderboard?limit=100')
    expect(res.data.ranks.global).toBe(board.data.me.rank)
  })

  it('has no rank for somebody who opted out of leaderboards', async () => {
    const u = await user()
    await project(u)
    await req(u.jar, 'PATCH', '/api/users/me/profile', { hideFromLeaderboards: true })
    await project(u)
    const start = Date.now()
    let ranks = (await card(u, u.userId)).data.ranks
    while (ranks.global !== null && Date.now() - start < 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await project(u) // an award retires the cached card; the job moving them off the board runs meanwhile
      ranks = (await card(u, u.userId)).data.ranks
    }
    expect(ranks).toEqual({ global: null, country: null, city: null })
  })

  it('counts the teams the person is in', async () => {
    const u = await user()
    const team = await req(u.jar, 'POST', '/api/teams', { name: `Pc Crew ${suffix}${n++}` })
    expect(team.status).toBe(201)
    await project(u)
    expect((await card(u, u.userId)).data.counts.crews).toBe(1)
  })

  describe('who may see what', () => {
    it('lets anybody signed in read anybody’s card', async () => {
      const owner = await user()
      const viewer = await user()
      await project(owner)
      const res = await card(viewer, owner.userId)
      expect(res.status).toBe(200)
      expect(res.data.xp).toBe(75)
      expect(res.data.streak).toMatchObject({ current: 1 })
    })

    it('hides the streak from others, not from the owner, when the person keeps their activity private', async () => {
      const owner = await user()
      const viewer = await user()
      await project(owner)
      expect((await req(owner.jar, 'PATCH', '/api/users/me/profile', { showActivity: false })).status).toBe(200)
      const others = await card(viewer, owner.userId)
      expect(others.data.streak).toBeNull()
      expect(others.data.xp).toBe(75) // everything else stays
      expect((await card(owner, owner.userId)).data.streak).toMatchObject({ current: 1 })
      await req(owner.jar, 'PATCH', '/api/users/me/profile', { showActivity: true })
      expect((await card(viewer, owner.userId)).data.streak).toMatchObject({ current: 1 })
    })

    it('looks like a missing user to somebody the owner has blocked, and not to the one who blocked', async () => {
      const owner = await user()
      const blocked = await user()
      await req(owner.jar, 'POST', '/api/blocks', { userId: blocked.userId })
      expect((await card(blocked, owner.userId)).status).toBe(404)
      expect((await card(owner, blocked.userId)).status).toBe(200)
    })

    it('is gone for a deleted account', async () => {
      const owner = await user()
      const viewer = await user()
      await testPrisma.user.update({ where: { id: owner.userId }, data: { deletedAt: new Date() } })
      expect((await card(viewer, owner.userId)).status).toBe(404)
    })
  })
})
