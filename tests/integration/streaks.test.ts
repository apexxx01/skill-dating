import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { addDaysToDateKey, localDateKey } from '../../src/lib/time'

// Streaks and seasons through the real routes: a day counts when the user earned XP from an action
// of their own, the rewards envelope reports it, and every award is stamped with the active season.
// Calendar situations (yesterday, a missed day, a month away) are set up by moving the stored
// "last counting day", since the clock itself cannot be moved from here.
describe('streaks', () => {
  const suffix = uniqueSuffix()
  let n = 0
  afterAll(() => cleanupTestUsers(suffix), 180_000)

  const user = async (timezone: string | null = null): Promise<TestUser> => {
    const name = `st${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    if (timezone) await testPrisma.user.update({ where: { id: u.userId }, data: { timezone } })
    return u
  }
  const today = (timezone: string | null = null) => localDateKey(new Date(), timezone)
  const setStreak = (u: TestUser, data: { currentStreak: number; longestStreak: number; lastStreakDay: string | null; streakFreezes?: number }) =>
    testPrisma.user.update({ where: { id: u.userId }, data })
  const row = (u: TestUser) => testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })
  const act = async (u: TestUser) => {
    const res = await req(u.jar, 'POST', '/api/projects', { name: `Streak ${suffix}${n++}` })
    expect(res.status).toBe(201)
    return res.data.rewards
  }

  it('starts at 1 with the first action, and says the streak grew', async () => {
    const u = await user()
    const rewards = await act(u)
    expect(rewards.streak).toEqual({ current: 1, longest: 1, extended: true, freezeUsed: false })
    expect(await row(u)).toMatchObject({ currentStreak: 1, longestStreak: 1, lastStreakDay: today(), streakFreezes: 0 })
  })

  it('counts the day once: the second action of the day reports the streak without growing it', async () => {
    const u = await user()
    await act(u)
    const second = await act(u)
    expect(second.streak).toEqual({ current: 1, longest: 1, extended: false, freezeUsed: false })
    expect((await row(u)).currentStreak).toBe(1)
  })

  it('extends the day after yesterday, and keeps the best run', async () => {
    const u = await user()
    await setStreak(u, { currentStreak: 5, longestStreak: 9, lastStreakDay: addDaysToDateKey(today(), -1) })
    const rewards = await act(u)
    expect(rewards.streak).toEqual({ current: 6, longest: 9, extended: true, freezeUsed: false })
  })

  it('earns a freeze when a run reaches 7', async () => {
    const u = await user()
    await setStreak(u, { currentStreak: 6, longestStreak: 6, lastStreakDay: addDaysToDateKey(today(), -1) })
    await act(u)
    expect(await row(u)).toMatchObject({ currentStreak: 7, streakFreezes: 1 })
  })

  it('spends a banked freeze on one missed day and tells the client', async () => {
    const u = await user()
    await setStreak(u, { currentStreak: 12, longestStreak: 12, lastStreakDay: addDaysToDateKey(today(), -2), streakFreezes: 1 })
    const rewards = await act(u)
    expect(rewards.streak).toEqual({ current: 13, longest: 13, extended: true, freezeUsed: true })
    expect(await row(u)).toMatchObject({ streakFreezes: 0, streakFreezeUsed: true })
  })

  it('ends the streak after a missed day with no freeze, or after two with one', async () => {
    const none = await user()
    await setStreak(none, { currentStreak: 12, longestStreak: 12, lastStreakDay: addDaysToDateKey(today(), -2), streakFreezes: 0 })
    expect((await act(none)).streak).toEqual({ current: 1, longest: 12, extended: true, freezeUsed: false })

    const two = await user()
    await setStreak(two, { currentStreak: 12, longestStreak: 12, lastStreakDay: addDaysToDateKey(today(), -3), streakFreezes: 2 })
    expect((await act(two)).streak).toEqual({ current: 1, longest: 12, extended: true, freezeUsed: false })
    expect((await row(two)).streakFreezes).toBe(2)
  })

  it('follows the local day of the user: the date key is the one in their time zone', async () => {
    const u = await user('Pacific/Kiritimati')
    await act(u)
    expect((await row(u)).lastStreakDay).toBe(today('Pacific/Kiritimati'))
    const west = await user('Pacific/Pago_Pago')
    await act(west)
    expect((await row(west)).lastStreakDay).toBe(today('Pacific/Pago_Pago'))
  })

  it('reports where the streak stands on a request that earns nothing', async () => {
    const u = await user()
    await setStreak(u, { currentStreak: 12, longestStreak: 12, lastStreakDay: addDaysToDateKey(today(), -5) })
    const project = await req(u.jar, 'POST', '/api/projects', { name: `Lapsed ${suffix}${n++}` })
    // Creating the project counted today, and a lapsed run of 12 started over at 1; the best run is kept.
    expect(project.data.rewards.streak).toEqual({ current: 1, longest: 12, extended: true, freezeUsed: false })
    const again = await req(u.jar, 'PATCH', `/api/projects/${project.data.id}`, { status: 'BUILDING' })
    expect(again.status).toBe(200)
    expect(again.data.rewards.xpGained).toBe(0)
    expect(again.data.rewards.streak).toEqual({ current: 1, longest: 12, extended: false, freezeUsed: false })
  })

  it('does not let an endorsement from somebody else keep a streak alive', async () => {
    const owner = await user()
    const endorser = await user()
    await testPrisma.user.update({ where: { id: endorser.userId }, data: { verificationLevel: 'EMAIL', isEmailVerified: true } })
    const skill = await testPrisma.skill.create({ data: { name: `St Skill ${suffix}`, slug: `st-skill-${suffix}`, category: 'Test' } })
    try {
      await testPrisma.userSkill.create({ data: { userId: owner.userId, skillId: skill.id } })
      const evidence = await req(owner.jar, 'POST', '/api/evidence', { skillId: skill.id, type: 'PORTFOLIO', title: 'Work', url: 'https://example.com/x' })
      expect(evidence.status).toBe(201)
      // The owner's own action counted today; push their streak back so only the endorsement can touch it.
      await setStreak(owner, { currentStreak: 4, longestStreak: 4, lastStreakDay: addDaysToDateKey(today(), -1) })

      const endorsed = await req(endorser.jar, 'POST', `/api/evidence/${evidence.data.id}/endorse`)
      expect(endorsed.status).toBe(201)
      expect(await testPrisma.xPEvent.count({ where: { userId: owner.userId, type: 'EVIDENCE_ENDORSED' } })).toBe(1)
      expect(await row(owner)).toMatchObject({ currentStreak: 4, lastStreakDay: addDaysToDateKey(today(), -1) })
    } finally {
      await testPrisma.skill.deleteMany({ where: { id: skill.id } })
    }
  })

  it('counts the person who accepts a connection and not the one whose request was accepted', async () => {
    const accepter = await user()
    const sender = await user()
    await setStreak(sender, { currentStreak: 3, longestStreak: 3, lastStreakDay: addDaysToDateKey(today(), -1) })
    const connection = await testPrisma.connection.create({ data: { senderId: sender.userId, receiverId: accepter.userId, status: 'PENDING' } })
    const res = await req(accepter.jar, 'PATCH', `/api/connections/${connection.id}`, { status: 'ACCEPTED' })
    expect(res.status).toBe(200)
    expect(res.data.rewards.streak).toMatchObject({ current: 1, extended: true })
    expect(await testPrisma.xPEvent.count({ where: { userId: sender.userId, type: 'CONNECTION_ACCEPTED' } })).toBe(1)
    expect(await row(sender)).toMatchObject({ currentStreak: 3, lastStreakDay: addDaysToDateKey(today(), -1) })
  })

  it('does not move the streak when the action fails', async () => {
    const u = await user()
    const res = await req(u.jar, 'POST', '/api/projects', { name: '' })
    expect(res.status).toBe(400)
    expect(await row(u)).toMatchObject({ currentStreak: 0, lastStreakDay: null })
  })
})

describe('seasons: the stamp on every award', () => {
  const suffix = uniqueSuffix()
  afterAll(() => cleanupTestUsers(suffix), 180_000)

  it('stamps XP with the active season, and Season 1 is running from the migration', async () => {
    const season = await testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
    expect(season.number).toBeGreaterThanOrEqual(1)
    expect(season.endsAt.getTime()).toBeGreaterThan(season.startsAt.getTime())

    const name = `ss${suffix}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    const res = await req(u.jar, 'POST', '/api/projects', { name: `Season ${suffix}` })
    expect(res.status).toBe(201)
    const events = await testPrisma.xPEvent.findMany({ where: { userId: u.userId } })
    expect(events.length).toBeGreaterThanOrEqual(2) // the project and its achievement
    for (const event of events) expect(event.seasonId).toBe(season.id)
  })
})
