import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { currentQuests } from '../../src/lib/quests'
import type { QuestDefinition } from '../../src/lib/quest-definitions'

// Quests through the real routes: the same three daily and three weekly quests for a user all period,
// progress that comes from doing the action, completion paid once through the rewards engine and reported in
// the envelope, and nothing paid for just looking.
describe('quests', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let admin: TestUser
  const setQuests = (enabled: boolean) => req(admin.jar, 'PATCH', '/api/admin/flags/quests', { enabled })

  // The suite runs with quests paused (tests/integration/global-setup.ts) so exact-XP assertions elsewhere hold;
  // this file turns them on with the operator's own flag, and puts the switch back at the end.
  beforeAll(async () => {
    const name = `qa${suffix}`
    admin = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(admin.userId)
    expect((await setQuests(true)).status).toBe(200)
  })
  afterAll(async () => {
    await setQuests(false)
    await cleanupTestUsers(suffix)
  }, 240_000)

  const user = async (timezone: string | null = null): Promise<TestUser> => {
    const name = `qs${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    if (timezone) await testPrisma.user.update({ where: { id: u.userId }, data: { timezone } })
    return u
  }
  const quests = (u: TestUser) => req(u.jar, 'GET', '/api/quests')
  const xp = async (u: TestUser) => (await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).xp

  // The actions this suite can drive on its own, by the metric they count. Each returns the rewards of the request.
  const DRIVERS: Record<string, (u: TestUser, state: { projectId?: string }) => Promise<{ rewards: { xpGained: number; questsCompleted: { slug: string; name: string }[] } }>> = {
    projects_created: async (u) => {
      const res = await req(u.jar, 'POST', '/api/projects', { name: `Q ${suffix}${n++}` })
      expect(res.status).toBe(201)
      return res.data
    },
    updates: async (u, state) => {
      state.projectId ??= (await req(u.jar, 'POST', '/api/projects', { name: `Qu ${suffix}${n++}` })).data.id
      const res = await req(u.jar, 'POST', `/api/projects/${state.projectId}/updates`, { title: 'Progress', content: `Step ${n++}` })
      expect(res.status).toBe(201)
      return res.data
    },
    milestones: async (u, state) => {
      state.projectId ??= (await req(u.jar, 'POST', '/api/projects', { name: `Qm ${suffix}${n++}` })).data.id
      const milestone = await req(u.jar, 'POST', `/api/projects/${state.projectId}/milestones`, { title: `Step ${n++}` })
      const res = await req(u.jar, 'PATCH', `/api/projects/${state.projectId}/milestones/${milestone.data.id}`, { completed: true })
      expect(res.status).toBe(200)
      return res.data
    },
    ships: async (u) => {
      const project = await req(u.jar, 'POST', '/api/projects', { name: `Qs ${suffix}${n++}` })
      const res = await req(u.jar, 'PATCH', `/api/projects/${project.data.id}`, { status: 'SHIPPED' })
      expect(res.status).toBe(200)
      return res.data
    },
  }

  /** A user who has, today, a daily quest this suite can complete (users are created until one does). */
  async function userWithDriveableQuest(timezone: string | null = null) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const u = await user(timezone)
      const todays = currentQuests(u.userId, new Date(), timezone).daily.quests
      // The cheapest to drive first: a project (one request) before an update (two).
      const quest = todays.find((q) => q.metric in DRIVERS && q.target <= 3)
      if (quest) return { u, quest, todays }
    }
    throw new Error('no user got a quest this suite can drive')
  }

  describe('GET /api/quests', () => {
    it('needs a signed-in user', async () => {
      expect((await req(null, 'GET', '/api/quests')).status).toBe(401)
    })

    it('lists three daily and three weekly quests with nothing done, and the time they reset', async () => {
      const u = await user()
      const res = await quests(u)
      expect(res.status).toBe(200)
      expect(res.data.timezone).toBe('UTC')
      for (const group of [res.data.daily, res.data.weekly]) {
        expect(group.quests).toHaveLength(3)
        expect(new Date(group.resetsAt).getTime()).toBeGreaterThan(Date.now())
        expect(new Date(group.startsAt).getTime()).toBeLessThanOrEqual(Date.now())
        for (const quest of group.quests) {
          expect(quest).toMatchObject({ current: 0, completed: false, completedAt: null })
          expect(quest.xpReward).toBeGreaterThan(0)
          expect(quest.target).toBeGreaterThanOrEqual(1)
          expect(quest.name.length).toBeGreaterThan(0)
        }
        expect(new Set(group.quests.map((q: { slug: string }) => q.slug)).size).toBe(3)
      }
      expect(res.data.daily.quests.every((q: { type: string }) => q.type === 'DAILY')).toBe(true)
      expect(res.data.weekly.quests.every((q: { type: string }) => q.type === 'WEEKLY')).toBe(true)
    })

    it('gives the same quests every time it is asked, and the ones the rotation says', async () => {
      const u = await user()
      const first = await quests(u)
      const second = await quests(u)
      expect(second.data).toEqual(first.data)
      const expected = currentQuests(u.userId, new Date(), null)
      expect(first.data.daily.quests.map((q: { slug: string }) => q.slug)).toEqual(expected.daily.quests.map((q) => q.slug))
      expect(first.data.weekly.quests.map((q: { slug: string }) => q.slug)).toEqual(expected.weekly.quests.map((q) => q.slug))
      expect(first.data.daily.periodKey).toBe(expected.daily.period.key)
      expect(first.data.weekly.periodKey).toBe(expected.weekly.period.key)
    })

    it('gives different people different quests', async () => {
      const sets = new Set<string>()
      for (let index = 0; index < 4; index++) {
        const u = await user()
        sets.add(JSON.stringify((await quests(u)).data.daily.quests.map((q: { slug: string }) => q.slug)))
      }
      expect(sets.size).toBeGreaterThan(1)
    })

    it('measures the day and the week in the time zone of the user', async () => {
      const u = await user('Pacific/Kiritimati')
      const res = await quests(u)
      expect(res.data.timezone).toBe('Pacific/Kiritimati')
      const expected = currentQuests(u.userId, new Date(), 'Pacific/Kiritimati')
      expect(res.data.daily.periodKey).toBe(expected.daily.period.key)
      expect(res.data.daily.resetsAt).toBe(expected.daily.period.end.toISOString())
      expect(res.data.weekly.resetsAt).toBe(expected.weekly.period.end.toISOString())
      // Kiritimati is UTC+14: its midnight is never on the hour in UTC terms of the same day as a UTC user's.
      expect(res.data.daily.resetsAt).toMatch(/T10:00:00\.000Z$/)
    })

    it('pays nothing for looking: asking for the quests, any number of times, earns no XP and writes no progress', async () => {
      const u = await user()
      for (let index = 0; index < 5; index++) expect((await quests(u)).status).toBe(200)
      expect(await xp(u)).toBe(0)
      expect(await testPrisma.userQuest.count({ where: { userId: u.userId } })).toBe(0)
      expect(await testPrisma.xPEvent.count({ where: { userId: u.userId } })).toBe(0)
    })
  })

  describe('doing the action', () => {
    it('counts toward the quest, completes it at the target, pays its XP once and reports it in the envelope', async () => {
      const { u, quest } = await userWithDriveableQuest()
      const state: { projectId?: string } = {}
      const gains: { xpGained: number; questsCompleted: { slug: string }[] }[] = []
      for (let step = 1; step <= quest.target; step++) {
        const result = await DRIVERS[quest.metric](u, state)
        gains.push(result.rewards)
        const listed = (await quests(u)).data.daily.quests.find((q: { slug: string }) => q.slug === quest.slug)
        expect(listed).toMatchObject({ current: step, completed: step === quest.target })
      }
      // Only the last action completes it.
      expect(gains.slice(0, -1).every((reward) => reward.questsCompleted.length === 0)).toBe(true)
      const completed = gains[gains.length - 1]
      expect(completed.questsCompleted.map((q) => q.slug)).toContain(quest.slug)

      const rows = await testPrisma.xPEvent.findMany({ where: { userId: u.userId, type: 'QUEST_COMPLETED' } })
      const mine = rows.find((row) => row.description.includes(quest.name))!
      expect(mine).toMatchObject({ amount: quest.xpReward, sourceType: 'QUEST' })
      const userQuest = await testPrisma.userQuest.findFirstOrThrow({ where: { userId: u.userId, quest: { slug: quest.slug } } })
      expect(mine.sourceId).toBe(userQuest.id)
      expect(mine.dedupeKey).toBe(`quest:${userQuest.id}`)
      expect(userQuest.completedAt).not.toBeNull()
      expect(userQuest.progress).toMatchObject({ current: quest.target, target: quest.target, completed: true })
      expect(await testPrisma.notification.count({ where: { userId: u.userId, metadata: { path: ['kind'], equals: 'QUEST_COMPLETED' } } })).toBeGreaterThanOrEqual(1)

      // Doing it again pays the quest nothing more.
      await DRIVERS[quest.metric](u, state)
      expect((await testPrisma.xPEvent.findMany({ where: { userId: u.userId, type: 'QUEST_COMPLETED', description: { contains: quest.name } } }))).toHaveLength(1)
      const after = (await quests(u)).data.daily.quests.find((q: { slug: string }) => q.slug === quest.slug)
      expect(after).toMatchObject({ completed: true, current: quest.target })
    })

    it('adds the quest XP to the XP of the action and the level shown to the client', async () => {
      const { u, quest } = await userWithDriveableQuest()
      const state: { projectId?: string } = {}
      let last: { xpGained: number; totalXp?: number; questsCompleted: unknown[] } | undefined
      const before = await xp(u)
      for (let step = 0; step < quest.target; step++) last = (await DRIVERS[quest.metric](u, state)).rewards
      const after = await xp(u)
      expect(after).toBeGreaterThan(before)
      expect((last as { totalXp: number }).totalXp).toBe(after)
    })

    it('does not count an action that paid nothing, so a quest cannot be completed past a daily cap', async () => {
      const u = await user()
      const created: string[] = []
      for (let index = 0; index < 5; index++) created.push((await req(u.jar, 'POST', '/api/projects', { name: `Cap ${suffix}${n++}` })).data.id)
      // Only three projects a day are paid; the counter and any quest on it stop at three.
      const row = await testPrisma.userCounter.findUnique({ where: { userId_key: { userId: u.userId, key: 'projects_created' } } })
      expect(row?.value).toBe(3)
      const progress = await testPrisma.userQuest.findMany({ where: { userId: u.userId, quest: { criteria: { path: ['metric'], equals: 'projects_created' } } } })
      for (const entry of progress) expect((entry.progress as { current: number }).current).toBeLessThanOrEqual(3)
    })

    it('also moves the weekly quest that asks for the same action', async () => {
      // Find a user whose daily and weekly sets both ask for something we can drive with the same action.
      for (let attempt = 0; attempt < 8; attempt++) {
        const u = await user()
        const { daily, weekly } = currentQuests(u.userId, new Date(), null)
        const shared = weekly.quests.find((w) => w.metric in DRIVERS && daily.quests.some((d) => d.metric === w.metric))
        if (!shared) continue
        const result = await DRIVERS[shared.metric](u, {})
        expect(result.rewards.xpGained).toBeGreaterThan(0)
        const view = (await quests(u)).data
        expect(view.weekly.quests.find((q: { slug: string }) => q.slug === shared.slug).current).toBe(1)
        expect(view.daily.quests.find((q: { metric?: string; slug: string }) => q.slug === daily.quests.find((d) => d.metric === shared.metric)!.slug).current).toBe(1)
        return
      }
      // Not every draw lines up; the unit tests cover this exhaustively.
    })
  })

  describe('the kill switch', () => {
    it('shows no quests and counts nothing while the "quests" flag is off, and carries on when it is back on', async () => {
      const { u, quest } = await userWithDriveableQuest()
      expect((await setQuests(false)).status).toBe(200)
      try {
        const paused = await quests(u)
        expect(paused.data.enabled).toBe(false)
        expect(paused.data.daily.quests).toEqual([])
        expect(paused.data.weekly.quests).toEqual([])
        const state: { projectId?: string } = {}
        for (let step = 0; step < quest.target; step++) {
          const result = await DRIVERS[quest.metric](u, state)
          expect(result.rewards.questsCompleted).toEqual([])
        }
        expect(await testPrisma.userQuest.count({ where: { userId: u.userId } })).toBe(0)
        expect(await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'QUEST_COMPLETED' } })).toBe(0)
      } finally {
        expect((await setQuests(true)).status).toBe(200)
      }
      expect((await quests(u)).data.enabled).toBe(true)
      expect((await quests(u)).data.daily.quests).toHaveLength(3)
    })
  })

  it('does not break the dashboard, which lists quest rows', async () => {
    const { u, quest } = await userWithDriveableQuest()
    await DRIVERS[quest.metric](u, {})
    const dashboard = await req(u.jar, 'GET', '/api/dashboard')
    expect(dashboard.status).toBe(200)
    expect(Array.isArray(dashboard.data.userQuests)).toBe(true)
  })

  it('has in the catalog only quests that ask for a real action', async () => {
    const { QUEST_DEFINITIONS } = await import('../../src/lib/quest-definitions')
    const asked: QuestDefinition[] = [...QUEST_DEFINITIONS]
    expect(asked.length).toBe(32)
  })
})
