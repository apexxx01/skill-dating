import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { ACHIEVEMENT_DEFINITIONS } from '../../src/lib/achievement-definitions'
import { xpAtLevelStart } from '../../src/lib/levels'
import { addDaysToDateKey, localDateKey } from '../../src/lib/time'

// Achievements v2 through the real routes: counters moved by domain events, tiers that unlock as they are
// reached, secret achievements masked until earned, and the unlocks arriving in the rewards envelope.
describe('achievements v2', () => {
  const suffix = uniqueSuffix()
  let n = 0
  afterAll(() => cleanupTestUsers(suffix), 240_000)

  const user = async (): Promise<TestUser> => {
    const name = `av${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  const counter = (u: TestUser, key: string) => testPrisma.userCounter.findUnique({ where: { userId_key: { userId: u.userId, key } } }).then((row) => row?.value ?? 0)
  const setCounter = (u: TestUser, key: string, value: number) =>
    testPrisma.userCounter.upsert({ where: { userId_key: { userId: u.userId, key } }, create: { userId: u.userId, key, value }, update: { value } })
  const earned = async (u: TestUser) => (await testPrisma.userAchievement.findMany({ where: { userId: u.userId }, select: { achievement: { select: { slug: true } } } })).map((row) => row.achievement.slug).sort()
  const list = (u: TestUser) => req(u.jar, 'GET', '/api/achievements')
  const project = async (u: TestUser) => {
    const res = await req(u.jar, 'POST', '/api/projects', { name: `Av ${suffix}${n++}` })
    expect(res.status).toBe(201)
    return res.data as { id: string; rewards: { achievements: { slug: string }[]; xpGained: number } }
  }
  const ship = async (u: TestUser, projectId: string) => {
    const res = await req(u.jar, 'PATCH', `/api/projects/${projectId}`, { status: 'SHIPPED' })
    expect(res.status).toBe(200)
    return res.data.rewards as { achievements: { slug: string }[]; xpGained: number; streak: unknown }
  }
  const slugs = (rewards: { achievements: { slug: string }[] }) => rewards.achievements.map((a) => a.slug).sort()

  describe('GET /api/achievements', () => {
    it('needs a signed-in user', async () => {
      expect((await req(null, 'GET', '/api/achievements')).status).toBe(401)
    })

    it('lists the 43 achievements for a new user, six of them masked', async () => {
      const u = await user()
      const res = await list(u)
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ earned: 0, total: 43 })
      expect(res.data.achievements).toHaveLength(43)
      expect(res.data.achievements.filter((item: { masked: boolean }) => item.masked)).toHaveLength(6)
      const body = JSON.stringify(res.data)
      for (const slug of ['night-owl', 'hat-trick', 'no-safety-net', 'golden-vouch', 'weekend-warrior', 'comeback-kid']) expect(body).not.toContain(slug)
      expect(res.data.achievements[0]).toMatchObject({ slug: 'first-project', earned: false, progress: { current: 0, target: 1 }, masked: false })
    })
  })

  describe('tiers', () => {
    it('unlocks the first tier of a series with the action, and reports it in the envelope', async () => {
      const u = await user()
      const created = await project(u)
      expect(slugs(created.rewards)).toEqual(['first-project'])
      expect(await counter(u, 'projects_created')).toBe(1)

      const rewards = await ship(u, created.id)
      expect(slugs(rewards)).toEqual(['first-ship'])
      expect(rewards.xpGained).toBe(200 + 100) // the ship and the achievement
      expect(await counter(u, 'ships')).toBe(1)
      expect(await testPrisma.userAchievement.findFirst({ where: { userId: u.userId, achievement: { slug: 'first-ship' } } })).toMatchObject({ progress: { current: 1, target: 1 } })
    })

    it('unlocks the next tier when the counter reaches it, and catches up the tiers a counter has already passed', async () => {
      const u = await user()
      await setCounter(u, 'ships', 4) // history from before the counters existed
      const created = await project(u)
      const rewards = await ship(u, created.id)
      // The counter is now 5: Shipped It (1) and Shipping Habit (5) both unlock.
      expect(slugs(rewards)).toEqual(['first-ship', 'ship-5'])
      expect(rewards.xpGained).toBe(200 + 100 + 100)
      expect(await testPrisma.userAchievement.findFirst({ where: { userId: u.userId, achievement: { slug: 'ship-5' } } })).toMatchObject({ progress: { current: 5, target: 5 } })
      const items = (await list(u)).data.achievements
      expect(items.find((item: { slug: string }) => item.slug === 'ship-25')).toMatchObject({ earned: false, progress: { current: 5, target: 25 } })
    })

    it('counts a repeated action once: shipping again does not move the counter', async () => {
      const u = await user()
      const created = await project(u)
      await ship(u, created.id)
      const again = await req(u.jar, 'PATCH', `/api/projects/${created.id}`, { status: 'SHIPPED' })
      expect(again.data.rewards.xpGained).toBe(0)
      expect(await counter(u, 'ships')).toBe(1)
    })

    it('does not count an action that paid no XP because of a daily cap', async () => {
      const u = await user()
      const ids: string[] = []
      for (let index = 0; index < 4; index++) ids.push((await project(u)).id)
      // Only three projects are paid a day; the fourth is created, but it is not counted.
      expect(await counter(u, 'projects_created')).toBe(3)
      for (const id of ids) await req(u.jar, 'PATCH', `/api/projects/${id}`, { status: 'SHIPPED' })
      expect(await counter(u, 'ships')).toBe(3)
    })

    it('unlocks milestones, updates and evidence series from the counters', async () => {
      const u = await user()
      await setCounter(u, 'milestones', 9)
      const created = await project(u)
      const milestone = await req(u.jar, 'POST', `/api/projects/${created.id}/milestones`, { title: 'Tenth' })
      const done = await req(u.jar, 'PATCH', `/api/projects/${created.id}/milestones/${milestone.data.id}`, { completed: true })
      expect(done.status).toBe(200)
      expect(slugs(done.data.rewards)).toEqual(['first-milestone', 'milestones-10'])
      expect(await counter(u, 'milestones')).toBe(10)
    })
  })

  describe('secret achievements', () => {
    it('Hat Trick: three ships in one week unlock it, and the list then shows it in full', async () => {
      const u = await user()
      const ids: string[] = []
      for (let index = 0; index < 3; index++) ids.push((await project(u)).id)
      await ship(u, ids[0])
      await ship(u, ids[1])
      expect((await list(u)).data.achievements.filter((item: { masked: boolean }) => item.masked)).toHaveLength(6)
      const third = await ship(u, ids[2])
      expect(slugs(third)).toContain('hat-trick')
      expect(await earned(u)).toContain('hat-trick')

      const items = (await list(u)).data.achievements
      expect(items.filter((item: { masked: boolean }) => item.masked)).toHaveLength(5)
      expect(items.find((item: { slug: string }) => item.slug === 'hat-trick')).toMatchObject({ name: 'Hat Trick', earned: true, secret: true, masked: false, xpReward: 100 })
    })

    it('Golden Vouch: the first endorsement from a Gold builder, and not from one below Gold', async () => {
      const owner = await user()
      const gold = await user()
      const silver = await user()
      const skill = await testPrisma.skill.create({ data: { name: `Av Skill ${suffix}`, slug: `av-skill-${suffix}`, category: 'Test' } })
      try {
        await testPrisma.userSkill.create({ data: { userId: owner.userId, skillId: skill.id } })
        for (const endorser of [gold, silver]) await testPrisma.user.update({ where: { id: endorser.userId }, data: { verificationLevel: 'EMAIL', isEmailVerified: true } })
        await testPrisma.user.update({ where: { id: gold.userId }, data: { xp: xpAtLevelStart(20) } })
        await testPrisma.user.update({ where: { id: silver.userId }, data: { xp: xpAtLevelStart(20) - 1 } })
        const evidence = async () => (await req(owner.jar, 'POST', '/api/evidence', { skillId: skill.id, type: 'PORTFOLIO', title: `Work ${n++}`, url: 'https://example.com/x' })).data.id as string

        expect((await req(silver.jar, 'POST', `/api/evidence/${await evidence()}/endorse`)).status).toBe(201)
        expect(await earned(owner)).toContain('endorsed')
        expect(await earned(owner)).not.toContain('golden-vouch')
        // The endorser has now given one.
        expect(await earned(silver)).toContain('endorser-1')
        expect(await counter(silver, 'endorsements_given')).toBe(1)

        expect((await req(gold.jar, 'POST', `/api/evidence/${await evidence()}/endorse`)).status).toBe(201)
        expect(await earned(owner)).toContain('golden-vouch')
        expect(await counter(owner, 'endorsements_received')).toBe(2)
      } finally {
        await testPrisma.skill.deleteMany({ where: { id: skill.id } })
      }
    })

    it('does not count an endorsement twice when it is withdrawn and given again', async () => {
      const owner = await user()
      const endorser = await user()
      const skill = await testPrisma.skill.create({ data: { name: `Av Skill2 ${suffix}`, slug: `av-skill2-${suffix}`, category: 'Test' } })
      try {
        await testPrisma.userSkill.create({ data: { userId: owner.userId, skillId: skill.id } })
        await testPrisma.user.update({ where: { id: endorser.userId }, data: { verificationLevel: 'EMAIL', isEmailVerified: true } })
        const evidence = (await req(owner.jar, 'POST', '/api/evidence', { skillId: skill.id, type: 'PORTFOLIO', title: 'Work', url: 'https://example.com/x' })).data.id
        for (let round = 0; round < 3; round++) {
          expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(201)
          expect((await req(endorser.jar, 'DELETE', `/api/evidence/${evidence}/endorse`)).status).toBe(200)
        }
        expect(await counter(owner, 'endorsements_received')).toBe(1)
        expect(await counter(endorser, 'endorsements_given')).toBe(1)
      } finally {
        await testPrisma.skill.deleteMany({ where: { id: skill.id } })
      }
    })

    it('an unverified endorser moves nobody’s counters', async () => {
      const owner = await user()
      const endorser = await user()
      await testPrisma.user.update({ where: { id: endorser.userId }, data: { verificationLevel: 'NONE', isEmailVerified: false } })
      const skill = await testPrisma.skill.create({ data: { name: `Av Skill3 ${suffix}`, slug: `av-skill3-${suffix}`, category: 'Test' } })
      try {
        await testPrisma.userSkill.create({ data: { userId: owner.userId, skillId: skill.id } })
        const evidence = (await req(owner.jar, 'POST', '/api/evidence', { skillId: skill.id, type: 'PORTFOLIO', title: 'Work', url: 'https://example.com/x' })).data.id
        expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(201)
        expect(await counter(owner, 'endorsements_received')).toBe(0)
        expect(await counter(endorser, 'endorsements_given')).toBe(0)
        expect(await earned(endorser)).toEqual([])
      } finally {
        await testPrisma.skill.deleteMany({ where: { id: skill.id } })
      }
    })
  })

  describe('streak achievements', () => {
    const today = () => localDateKey(new Date(), null)
    const setStreak = (u: TestUser, current: number, daysAgo: number, extra: Record<string, unknown> = {}) =>
      testPrisma.user.update({ where: { id: u.userId }, data: { currentStreak: current, longestStreak: current, lastStreakDay: addDaysToDateKey(today(), -daysAgo), ...extra } })

    it('unlocks Week Warrior when the streak reaches 7', async () => {
      const u = await user()
      await setStreak(u, 6, 1)
      const created = await project(u)
      expect(slugs(created.rewards)).toEqual(['first-project', 'streak-7'])
      expect(created.rewards.xpGained).toBe(50 + 25 + 40)
    })

    it('unlocks No Safety Net at 30 days without a freeze, and not when a freeze was spent in the run', async () => {
      const clean = await user()
      await setStreak(clean, 29, 1)
      expect(slugs((await project(clean)).rewards)).toEqual(['first-project', 'no-safety-net', 'streak-30', 'streak-7'])

      const frozen = await user()
      await setStreak(frozen, 29, 1, { streakFreezeUsed: true })
      expect(slugs((await project(frozen)).rewards)).toEqual(['first-project', 'streak-30', 'streak-7'])
    })

    it('unlocks Comeback Kid for earning again after more than 30 idle days, and not for a short break', async () => {
      const away = await user()
      await setStreak(away, 3, 45)
      expect(slugs((await project(away)).rewards)).toEqual(['comeback-kid', 'first-project'])

      const short = await user()
      await setStreak(short, 3, 20)
      expect(slugs((await project(short)).rewards)).toEqual(['first-project'])
    })
  })

  describe('replies', () => {
    it('counts answering a message that was waiting on you, once per message', async () => {
      const a = await user()
      const b = await user()
      const conversation = await testPrisma.conversation.create({
        data: { type: 'DIRECT', members: { create: [{ userId: a.userId, role: 'OWNER' }, { userId: b.userId, role: 'MEMBER' }] } },
      })
      const send = (u: TestUser, content: string) => req(u.jar, 'POST', `/api/conversations/${conversation.id}`, { content })

      expect((await send(a, 'Hi')).status).toBe(201)
      expect(await counter(a, 'replies')).toBe(0) // nobody was waiting on a
      expect((await send(a, 'Anyone?')).status).toBe(201)
      expect(await counter(a, 'replies')).toBe(0) // still nobody
      expect((await send(b, 'Hello!')).status).toBe(201)
      expect(await counter(b, 'replies')).toBe(1)
      expect((await send(b, 'And one more')).status).toBe(201)
      expect(await counter(b, 'replies')).toBe(1) // that one was a follow-up, not an answer
      expect((await send(a, 'Great')).status).toBe(201)
      expect(await counter(a, 'replies')).toBe(1)
    })

    it('does not count a message in a group room', async () => {
      const a = await user()
      const b = await user()
      const room = await testPrisma.conversation.create({
        data: { type: 'GROUP', members: { create: [{ userId: a.userId, role: 'OWNER' }, { userId: b.userId, role: 'MEMBER' }] } },
      })
      await req(a.jar, 'POST', `/api/conversations/${room.id}`, { content: 'Hi all' })
      await req(b.jar, 'POST', `/api/conversations/${room.id}`, { content: 'Hi' })
      expect(await counter(b, 'replies')).toBe(0)
    })
  })

  describe('GET /api/users/{id}/achievements', () => {
    it('shows another person’s earned achievements and progress, with the secret ones still masked', async () => {
      const owner = await user()
      const viewer = await user()
      await project(owner)
      const res = await req(viewer.jar, 'GET', `/api/users/${owner.userId}/achievements`)
      expect(res.status).toBe(200)
      expect(res.data.earned).toBe(1)
      expect(res.data.achievements.find((item: { slug: string }) => item.slug === 'first-project')).toMatchObject({ earned: true })
      expect(res.data.achievements.filter((item: { masked: boolean }) => item.masked)).toHaveLength(6)
    })

    it('is a missing user for somebody who has been blocked, and for ids that do not exist', async () => {
      const owner = await user()
      const blocked = await user()
      await req(owner.jar, 'POST', '/api/blocks', { userId: blocked.userId })
      expect((await req(blocked.jar, 'GET', `/api/users/${owner.userId}/achievements`)).status).toBe(404)
      expect((await req(owner.jar, 'GET', `/api/users/${blocked.userId}/achievements`)).status).toBe(200)
      expect((await req(owner.jar, 'GET', '/api/users/nonexistent123/achievements')).status).toBe(404)
      expect((await req(null, 'GET', `/api/users/${owner.userId}/achievements`)).status).toBe(401)
    })
  })

  describe('rarity: the achievements/rarity job', () => {
    let admin: TestUser
    beforeAll(async () => {
      admin = await user()
      await promoteToAdmin(admin.userId)
    })

    it('gives every achievement a share of the users active in the last 30 days that have it', async () => {
      const earnerA = await user()
      await project(earnerA)
      await project(await user())

      const run = await req(admin.jar, 'POST', '/api/admin/jobs/achievements/rarity')
      expect(run.status).toBe(200)
      expect(run.data.result.achievements).toBe(43)

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const active = await testPrisma.user.count({ where: { lastActiveAt: { gte: since }, deletedAt: null } })
      const firstProject = await testPrisma.userAchievement.count({ where: { achievement: { slug: 'first-project' }, user: { lastActiveAt: { gte: since }, deletedAt: null } } })
      expect(run.data.result.activeUsers).toBeGreaterThanOrEqual(active - 3) // users created while it ran

      const rows = await testPrisma.achievement.findMany({ where: { slug: { in: Object.keys(ACHIEVEMENT_DEFINITIONS) } } })
      expect(rows).toHaveLength(43)
      for (const row of rows) {
        expect(row.rarity, row.slug).not.toBeNull()
        expect(row.rarity!).toBeGreaterThanOrEqual(0)
        expect(row.rarity!).toBeLessThanOrEqual(1)
        expect(row.rarityUpdatedAt).not.toBeNull()
      }
      const fp = rows.find((row) => row.slug === 'first-project')!
      expect(fp.rarity!).toBeCloseTo(firstProject / run.data.result.activeUsers, 1)
      expect(fp.rarity!).toBeGreaterThan(0)
      // Nobody has won ten hackathons.
      expect(rows.find((row) => row.slug === 'hackathon-legend')!.rarity).toBe(0)

      const items = (await list(earnerA)).data.achievements
      expect(items.find((item: { slug: string }) => item.slug === 'first-project').rarity).toBeCloseTo(fp.rarity!, 5)
      // A secret achievement nobody earned stays masked, rarity included.
      expect(items.find((item: { masked: boolean }) => item.masked).rarity).toBeNull()
    })
  })
})
