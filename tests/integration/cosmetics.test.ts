import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { xpAtLevelStart } from '../../src/lib/levels'
import { addDaysToDateKey, localDateKey } from '../../src/lib/time'

// Cosmetics through the real routes: earned by tiers, achievements and streaks (and by nothing else), listed
// with the secret ones masked, worn only when owned, and never for sale or for the asking.
describe('cosmetics', () => {
  const suffix = uniqueSuffix().toLowerCase()
  let n = 0
  let operator: TestUser
  afterAll(() => cleanupTestUsers(suffix), 300_000)
  beforeAll(async () => {
    const name = `cmop${suffix}`
    operator = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(operator.userId)
  })

  const user = async (): Promise<TestUser> => {
    const name = `cm${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  const list = (u: TestUser) => req(u.jar, 'GET', '/api/users/me/cosmetics')
  const owned = async (u: TestUser) => (await testPrisma.userCosmetic.findMany({ where: { userId: u.userId }, select: { cosmetic: { select: { slug: true } } } })).map((row) => row.cosmetic.slug).sort()
  const project = async (u: TestUser) => (await req(u.jar, 'POST', '/api/projects', { name: `Cm ${suffix}${n++}` })).data as { id: string; rewards: { achievements: { slug: string }[] } }
  const today = () => localDateKey(new Date(), null)

  describe('GET /api/users/me/cosmetics', () => {
    it('needs a signed-in user', async () => {
      expect((await req(null, 'GET', '/api/users/me/cosmetics')).status).toBe(401)
    })

    it('lists the 20 cosmetics for a new user, owning none, three of them masked', async () => {
      const u = await user()
      const res = await list(u)
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ owned: 0, total: 20, equipped: { title: null, frame: null, banner: null, badges: [] } })
      expect(res.data.cosmetics).toHaveLength(20)
      const masked = res.data.cosmetics.filter((item: { masked: boolean }) => item.masked)
      expect(masked).toHaveLength(3)
      for (const item of masked) expect(item).toMatchObject({ name: 'Secret cosmetic', requirement: null, owned: false, slug: expect.stringMatching(/^secret-\d+$/) })
      const body = JSON.stringify(res.data)
      for (const hidden of ['title-night-owl', 'title-comeback', 'frame-golden-vouch', 'night-owl', 'comeback-kid', 'golden-vouch']) expect(body).not.toContain(hidden)
      const gold = res.data.cosmetics.find((item: { slug: string }) => item.slug === 'title-gold')
      expect(gold).toMatchObject({ type: 'TITLE', slot: 'title', owned: false, equipped: false, requirement: 'Reach the Gold tier', rarity: 'UNCOMMON' })
    })
  })

  describe('earning them', () => {
    it('gives the Bronze title with the first XP, and tells the user', async () => {
      const u = await user()
      await project(u)
      expect(await owned(u)).toEqual(['title-bronze'])
      const row = await testPrisma.userCosmetic.findFirstOrThrow({ where: { userId: u.userId } })
      expect(row.source).toBe('tier:BRONZE')
      expect(await testPrisma.notification.count({ where: { userId: u.userId, metadata: { path: ['kind'], equals: 'COSMETIC_UNLOCKED' } } })).toBe(1)
      const res = await list(u)
      expect(res.data.owned).toBe(1)
      expect(res.data.cosmetics.find((item: { slug: string }) => item.slug === 'title-bronze')).toMatchObject({ owned: true, unlockedAt: expect.any(String), requirement: null })
    })

    it('gives a tier title on reaching the tier, and the lower ones the person missed', async () => {
      const u = await user()
      await testPrisma.user.update({ where: { id: u.userId }, data: { xp: xpAtLevelStart(20) - 10 } })
      await project(u) // +50 crosses into Gold
      expect(await owned(u)).toEqual(['title-bronze', 'title-gold', 'title-silver'])
    })

    it('gives a frame when the streak reaches the milestone', async () => {
      const u = await user()
      await testPrisma.user.update({ where: { id: u.userId }, data: { currentStreak: 6, longestStreak: 6, lastStreakDay: addDaysToDateKey(today(), -1) } })
      await project(u)
      expect(await owned(u)).toContain('frame-streak-7')
      expect(await owned(u)).not.toContain('frame-streak-30')
    })

    it('gives what an achievement earns: a title and a banner for Centurion and Production Line', async () => {
      const u = await user()
      await testPrisma.userCounter.create({ data: { userId: u.userId, key: 'ships', value: 99 } })
      const created = await project(u)
      await req(u.jar, 'PATCH', `/api/projects/${created.id}`, { status: 'SHIPPED' })
      expect(await owned(u)).toEqual(expect.arrayContaining(['title-centurion', 'banner-shipper', 'title-bronze']))
    })

    it('reveals a secret cosmetic once it is owned', async () => {
      const u = await user()
      await testPrisma.user.update({ where: { id: u.userId }, data: { currentStreak: 3, longestStreak: 3, lastStreakDay: addDaysToDateKey(today(), -45) } })
      await project(u) // comes back after 45 days: the secret Comeback Kid
      expect(await owned(u)).toContain('title-comeback')
      const res = await list(u)
      expect(res.data.cosmetics.find((item: { slug: string }) => item.slug === 'title-comeback')).toMatchObject({ name: 'Comeback Kid', owned: true, masked: false })
      expect(res.data.cosmetics.filter((item: { masked: boolean }) => item.masked)).toHaveLength(2)
    })

    it('does not give one twice, however many times its trigger happens', async () => {
      const u = await user()
      await project(u)
      await project(u)
      await project(u)
      expect((await owned(u)).filter((slug) => slug === 'title-bronze')).toHaveLength(1)
    })
  })

  describe('wearing them: PATCH /api/users/me/equipped', () => {
    it('needs a signed-in user', async () => {
      expect((await req(null, 'PATCH', '/api/users/me/equipped', { title: null })).status).toBe(401)
    })

    it('wears what the user owns, shows it in the list and on the player card, and takes it off with null', async () => {
      const u = await user()
      await project(u)
      const res = await req(u.jar, 'PATCH', '/api/users/me/equipped', { title: 'title-bronze' })
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ equipped: { title: 'title-bronze', frame: null, banner: null, badges: [] } })
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).equipped).toEqual({ title: 'title-bronze', frame: null, banner: null, badges: [] })

      const listed = await list(u)
      expect(listed.data.equipped.title).toBe('title-bronze')
      expect(listed.data.cosmetics.find((item: { slug: string }) => item.slug === 'title-bronze').equipped).toBe(true)
      const card = await req(u.jar, 'GET', `/api/users/${u.userId}/stats`)
      expect(card.data.equipped.title).toEqual({ slug: 'title-bronze', name: 'Bronze Builder' })

      const cleared = await req(u.jar, 'PATCH', '/api/users/me/equipped', { title: null })
      expect(cleared.data.equipped.title).toBeNull()
    })

    it('leaves the slots that are not mentioned as they were', async () => {
      const u = await user()
      await testPrisma.user.update({ where: { id: u.userId }, data: { currentStreak: 6, longestStreak: 6, lastStreakDay: addDaysToDateKey(today(), -1) } })
      await project(u)
      await req(u.jar, 'PATCH', '/api/users/me/equipped', { title: 'title-bronze' })
      const frame = await req(u.jar, 'PATCH', '/api/users/me/equipped', { frame: 'frame-streak-7' })
      expect(frame.data.equipped).toEqual({ title: 'title-bronze', frame: 'frame-streak-7', banner: null, badges: [] })
    })

    it('refuses a cosmetic the user has not earned, one that does not exist, and changes nothing', async () => {
      const u = await user()
      await project(u)
      await req(u.jar, 'PATCH', '/api/users/me/equipped', { title: 'title-bronze' })
      for (const slug of ['title-mythic', 'title-gold', 'frame-streak-365', 'banner-legend', 'no-such-cosmetic']) {
        const body = slug.startsWith('frame') ? { frame: slug } : slug.startsWith('banner') ? { banner: slug } : { title: slug }
        const res = await req(u.jar, 'PATCH', '/api/users/me/equipped', body)
        expect(res.status, slug).toBe(403)
        expect(res.data.error.code, slug).toBe('COSMETIC_NOT_OWNED')
      }
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).equipped).toEqual({ title: 'title-bronze', frame: null, banner: null, badges: [] })
    })

    it('refuses a cosmetic in the wrong slot', async () => {
      const u = await user()
      await project(u)
      const res = await req(u.jar, 'PATCH', '/api/users/me/equipped', { frame: 'title-bronze' })
      expect(res.status).toBe(400)
      expect(res.data.error.code).toBe('COSMETIC_WRONG_SLOT')
    })

    it('does not let one user wear what another earned', async () => {
      const a = await user()
      const b = await user()
      await testPrisma.user.update({ where: { id: a.userId }, data: { currentStreak: 6, longestStreak: 6, lastStreakDay: addDaysToDateKey(today(), -1) } })
      await project(a)
      await project(b)
      expect(await owned(a)).toContain('frame-streak-7')
      const res = await req(b.jar, 'PATCH', '/api/users/me/equipped', { frame: 'frame-streak-7' })
      expect(res.status).toBe(403)
    })

    it('wears up to three badges, in order, replacing the list, and shows them on the player card', async () => {
      const u = await user()
      const slugs = [1, 2, 3, 4].map((season) => `season-${900 + season}-participant`)
      for (const [index, badge] of slugs.entries()) {
        const cosmetic = await testPrisma.cosmetic.upsert({
          where: { slug: badge },
          create: { slug: badge, type: 'BADGE', name: `Season ${900 + index + 1} Participant`, description: 'test', rarity: 'COMMON', unlockRule: { type: 'SEASON', season: 900 + index + 1, award: 'PARTICIPANT' }, order: 1 },
          update: {},
        })
        await testPrisma.userCosmetic.create({ data: { userId: u.userId, cosmeticId: cosmetic.id, source: 'test' } })
      }
      const wear = await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: [slugs[2], slugs[0]] })
      expect(wear.status).toBe(200)
      expect(wear.data.equipped.badges).toEqual([slugs[2], slugs[0]])
      const card = await req(u.jar, 'GET', `/api/users/${u.userId}/stats`)
      expect(card.data.equipped.badges).toEqual([
        { slug: slugs[2], name: 'Season 903 Participant' },
        { slug: slugs[0], name: 'Season 901 Participant' },
      ])
      const listed = await list(u)
      expect(listed.data.cosmetics.filter((item: { equipped: boolean; slug: string }) => item.equipped).map((item: { slug: string }) => item.slug).sort()).toEqual([slugs[0], slugs[2]].sort())

      // A slot not mentioned is left alone; an empty list takes every badge off.
      expect((await req(u.jar, 'PATCH', '/api/users/me/equipped', { title: null })).data.equipped.badges).toEqual([slugs[2], slugs[0]])
      expect((await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: [] })).data.equipped.badges).toEqual([])

      // Three at most, each once, and only badges that were earned.
      const four = await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: slugs })
      expect(four.status).toBe(400)
      expect(four.data.error.code).toBe('VALIDATION_FAILED')
      expect((await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: [slugs[0], slugs[0]] })).status).toBe(400)
      expect((await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: ['season-955-participant'] })).status).toBe(403)
      expect((await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: 'x' })).status).toBe(400)
      expect((await req(u.jar, 'PATCH', '/api/users/me/equipped', { badges: [null] })).status).toBe(400)
      const wrongSlot = await req(u.jar, 'PATCH', '/api/users/me/equipped', { frame: slugs[0] })
      expect(wrongSlot.status).toBe(400)
      expect(wrongSlot.data.error.code).toBe('COSMETIC_WRONG_SLOT')
    })

    it('validates the body: at least one slot, nothing else, text or null', async () => {
      const u = await user()
      for (const body of [{}, { hat: 'x' }, { title: 5 }, { title: '' }, { title: 'a'.repeat(65) }, { title: null, xp: 9 }]) {
        const res = await req(u.jar, 'PATCH', '/api/users/me/equipped', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    })
  })

  describe('never for sale, never for the asking', () => {
    it('has no route that grants, buys or removes a cosmetic', async () => {
      const u = await user()
      for (const [method, path] of [
        ['POST', '/api/users/me/cosmetics'],
        ['PUT', '/api/users/me/cosmetics'],
        ['PATCH', '/api/users/me/cosmetics'],
        ['DELETE', '/api/users/me/cosmetics'],
        ['POST', '/api/users/me/equipped'],
        ['PUT', '/api/users/me/equipped'],
        ['DELETE', '/api/users/me/equipped'],
        ['GET', '/api/users/me/equipped'],
      ] as const) {
        const res = await req(u.jar, method, path, method === 'GET' ? undefined : { slug: 'title-mythic' })
        expect(res.status, `${method} ${path}`).toBe(405)
      }
      expect(await owned(u)).toEqual([])
      for (const path of ['/api/cosmetics', '/api/shop', '/api/store', '/api/purchase', '/api/users/me/purchase']) {
        expect((await req(u.jar, 'POST', path, { slug: 'title-mythic' })).status, path).toBe(404)
      }
    })

    it('does not let anything but the rules fill an inventory: the same inputs give the same cosmetics', async () => {
      const a = await user()
      const b = await user()
      for (const u of [a, b]) await project(u)
      expect(await owned(a)).toEqual(await owned(b))
      expect(await owned(a)).toEqual(['title-bronze'])
    }, 90_000)
  })

  describe('people who earned things before cosmetics existed: cosmetics/backfill', () => {
    it('grants them what their XP, streak and achievements earned, quietly, and only once', async () => {
      const u = await user()
      await testPrisma.user.update({ where: { id: u.userId }, data: { xp: xpAtLevelStart(35), longestStreak: 31 } })
      const achievement = await testPrisma.achievement.upsert({
        where: { slug: 'hackathon-winner' },
        create: { slug: 'hackathon-winner', name: 'Hackathon Winner', description: 'x', category: 'HACKATHON', xpReward: 250, criteria: { metric: 'hackathon_wins', target: 1 }, order: 15 },
        update: {},
      })
      await testPrisma.userAchievement.create({ data: { userId: u.userId, achievementId: achievement.id } })

      const first = await req(operator.jar, 'POST', '/api/admin/jobs/cosmetics/backfill', { data: { limit: 5000 } })
      expect(first.status).toBe(200)
      expect(first.data.result.users).toBeGreaterThanOrEqual(1)
      expect(await owned(u)).toEqual(['banner-first-win', 'frame-streak-30', 'frame-streak-7', 'title-bronze', 'title-gold', 'title-platinum', 'title-silver'])
      expect(await testPrisma.notification.count({ where: { userId: u.userId, metadata: { path: ['kind'], equals: 'COSMETIC_UNLOCKED' } } })).toBe(0)

      const again = await req(operator.jar, 'POST', '/api/admin/jobs/cosmetics/backfill', { data: { limit: 5000 } })
      expect(again.data.result.granted).toBe(0)
    })
  })
})
