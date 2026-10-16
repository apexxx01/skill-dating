import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { localDateKey } from '../../src/lib/time'

const DAY_MS = 24 * 60 * 60 * 1000

describe('GET /api/users/{id}/heatmap', () => {
  const suffix = uniqueSuffix()
  let n = 0
  afterAll(() => cleanupTestUsers(suffix), 180_000)

  const user = async (timezone: string | null = null): Promise<TestUser> => {
    const name = `hm${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    if (timezone) await testPrisma.user.update({ where: { id: u.userId }, data: { timezone } })
    return u
  }
  const heatmap = (viewer: TestUser | null, userId: string, query = '') => req(viewer?.jar ?? null, 'GET', `/api/users/${userId}/heatmap${query}`)
  /** Writes an XP row straight into the log, `daysAgo` days back at the given UTC time. */
  const logXp = (userId: string, daysAgo: number, time: string, amount: number, type = 'PROJECT_UPDATE_POSTED') => {
    const day = new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10)
    return testPrisma.xPEvent.create({
      data: { userId, type, amount, description: 'test', sourceType: 'TEST', sourceId: `${n++}`, dedupeKey: `test:${Math.random()}`, createdAt: new Date(`${day}T${time}Z`) },
    })
  }

  it('needs a signed-in user', async () => {
    const u = await user()
    expect((await heatmap(null, u.userId)).status).toBe(401)
  })

  it('answers with the days that had XP, XP and actions per day, oldest first', async () => {
    const owner = await user()
    await logXp(owner.userId, 3, '10:00:00', 30, 'MILESTONE_COMPLETED')
    await logXp(owner.userId, 3, '11:00:00', 15, 'PROJECT_UPDATE_POSTED')
    await logXp(owner.userId, 3, '11:30:00', 25, 'ACHIEVEMENT_EARNED')
    await logXp(owner.userId, 6, '09:00:00', 50, 'PROJECT_CREATED')

    const res = await heatmap(owner, owner.userId, '?days=30')
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ timezone: 'UTC', days: 30, hidden: false })
    const key = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10)
    expect(res.data.items).toEqual([
      { date: key(6), xp: 50, actions: 1 },
      // The achievement's XP is in the day's total but it is not something the person did.
      { date: key(3), xp: 70, actions: 2 },
    ])
    expect(res.data.to).toBe(localDateKey(new Date(), 'UTC'))
    expect(res.data.from).toBe(key(29))
  })

  it('groups by the days of the profile owner, not of the viewer', async () => {
    const owner = await user('Asia/Kolkata')
    const viewer = await user('America/Los_Angeles')
    // 20:00Z is 01:30 the next day in Kolkata and 13:00 the same day in Los Angeles.
    const row = await logXp(owner.userId, 2, '20:00:00', 15)
    const res = await heatmap(viewer, owner.userId, '?days=10')
    expect(res.data.timezone).toBe('Asia/Kolkata')
    expect(res.data.items).toEqual([{ date: localDateKey(row.createdAt, 'Asia/Kolkata'), xp: 15, actions: 1 }])
    expect(localDateKey(row.createdAt, 'Asia/Kolkata')).not.toBe(localDateKey(row.createdAt, 'America/Los_Angeles'))
  })

  it('leaves out days before the window', async () => {
    const owner = await user()
    await logXp(owner.userId, 20, '10:00:00', 15)
    expect((await heatmap(owner, owner.userId, '?days=7')).data.items).toEqual([])
    expect((await heatmap(owner, owner.userId, '?days=30')).data.items).toHaveLength(1)
  })

  it('defaults to a year and validates the length of the window', async () => {
    const owner = await user()
    const res = await heatmap(owner, owner.userId)
    expect(res.data.days).toBe(365)
    for (const days of ['0', '366', '-1', 'abc', '1.5']) {
      const bad = await heatmap(owner, owner.userId, `?days=${days}`)
      expect(bad.status, days).toBe(400)
      expect(bad.data.error.code).toBe('VALIDATION_FAILED')
    }
    expect((await heatmap(owner, owner.userId, '?days=1')).status).toBe(200)
    expect((await heatmap(owner, owner.userId, '?days=365')).status).toBe(200)
  })

  it('is an empty list, not an error, for a person with no XP', async () => {
    const owner = await user()
    const res = await heatmap(owner, owner.userId)
    expect(res.status).toBe(200)
    expect(res.data.items).toEqual([])
  })

  it('answers 404 for a user that does not exist or an id that cannot be one', async () => {
    const viewer = await user()
    for (const id of ['nonexistent123', 'bad%20id', 'a'.repeat(100)]) {
      const res = await heatmap(viewer, id)
      expect(res.status, id).toBe(404)
      expect(res.data.error.code).toBe('USER_NOT_FOUND')
    }
  })

  it('is cached for 10 minutes and refreshed at once by a new award', async () => {
    const owner = await user()
    await logXp(owner.userId, 1, '10:00:00', 15)
    const first = await heatmap(owner, owner.userId, '?days=5')
    expect(first.data.items.reduce((sum: number, day: { xp: number }) => sum + day.xp, 0)).toBe(15)

    // A row written behind the engine's back is not seen: the cached answer is served.
    await logXp(owner.userId, 1, '12:00:00', 40)
    const cached = await heatmap(owner, owner.userId, '?days=5')
    expect(cached.data.items.reduce((sum: number, day: { xp: number }) => sum + day.xp, 0)).toBe(15)

    // An award through the engine retires the cached heatmap, so the next read has everything.
    const project = await req(owner.jar, 'POST', '/api/projects', { name: `Heat ${suffix}${n++}` })
    expect(project.status).toBe(201)
    const fresh = await heatmap(owner, owner.userId, '?days=5')
    expect(fresh.data.items.reduce((sum: number, day: { xp: number }) => sum + day.xp, 0)).toBe(15 + 40 + 75)
  })

  describe('privacy and blocks', () => {
    it('hides the heatmap from everybody but the owner when "show activity" is off', async () => {
      const owner = await user()
      const viewer = await user()
      await logXp(owner.userId, 1, '10:00:00', 15)
      expect((await req(owner.jar, 'PATCH', '/api/users/me/profile', { showActivity: false })).status).toBe(200)

      const others = await heatmap(viewer, owner.userId, '?days=5')
      expect(others.status).toBe(200)
      expect(others.data).toMatchObject({ hidden: true, items: [] })

      const own = await heatmap(owner, owner.userId, '?days=5')
      expect(own.data.hidden).toBe(false)
      expect(own.data.items).toHaveLength(1)

      await req(owner.jar, 'PATCH', '/api/users/me/profile', { showActivity: true })
      expect((await heatmap(viewer, owner.userId, '?days=5')).data.hidden).toBe(false)
    })

    it('looks like a missing user to somebody the owner has blocked, in either direction of the lookup', async () => {
      const owner = await user()
      const blocked = await user()
      await logXp(owner.userId, 1, '10:00:00', 15)
      await req(owner.jar, 'POST', '/api/blocks', { userId: blocked.userId })

      const hidden = await heatmap(blocked, owner.userId)
      expect(hidden.status).toBe(404)
      expect(hidden.data.error.code).toBe('USER_NOT_FOUND')
      // The blocker can still open it, as with the profile, to be able to unblock.
      expect((await heatmap(owner, blocked.userId)).status).toBe(200)

      await req(owner.jar, 'DELETE', `/api/blocks/${blocked.userId}`)
      expect((await heatmap(blocked, owner.userId)).status).toBe(200)
    })

    it('is gone for a deleted account', async () => {
      const owner = await user()
      const viewer = await user()
      await testPrisma.user.update({ where: { id: owner.userId }, data: { deletedAt: new Date() } })
      expect((await heatmap(viewer, owner.userId)).status).toBe(404)
    })
  })
})
