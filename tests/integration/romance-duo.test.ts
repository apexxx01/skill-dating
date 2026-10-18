import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, removePeople } from './matching-fixtures'

// Duo: two people of a romance match who both agree to share a page.
describe('Duo', () => {
  const suffix = uniqueSuffix()
  const tag = `du${suffix}`

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await testPrisma.notification.deleteMany({ where: { user: { username: { startsWith: tag.toLowerCase() } } } })
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 180_000)

  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a])
  async function person(label: string): Promise<TestUser> {
    const u = await registerAndLogin(`${tag}.${label}@test.dev`, `${tag}${label}`)
    await testPrisma.user.update({ where: { id: u.userId }, data: { birthDate: new Date(`${bornYearsAgo(30)}T00:00:00Z`), timezone: 'UTC' } })
    return u
  }
  async function matchOf(a: TestUser, b: TestUser, type: 'DATING' | 'COFOUNDER' = 'DATING') {
    const [userAId, userBId] = pair(a.userId, b.userId)
    return testPrisma.match.create({ data: { userAId, userBId, userARole: type, userBRole: type, connectionType: type } })
  }
  const duoOf = (u: TestUser) => req(u.jar, 'GET', '/api/romance/duo')

  it('needs a signed-in user and a body', async () => {
    expect((await req(null, 'GET', '/api/romance/duo')).status).toBe(401)
    expect((await req(null, 'POST', '/api/romance/duo', {})).status).toBe(401)
    expect((await req(null, 'DELETE', '/api/romance/duo')).status).toBe(401)
    const u = await person('v')
    expect((await req(u.jar, 'POST', '/api/romance/duo', {})).status).toBe(400)
    expect((await duoOf(u)).data).toEqual({ duo: null })
  }, 60_000)

  it('is formed by one asking and the other accepting, and is for the two of them only', async () => {
    const a = await person('a')
    const b = await person('b')
    const outsider = await person('c')
    const match = await matchOf(a, b)
    expect((await req(outsider.jar, 'POST', '/api/romance/duo', { matchId: match.id })).status).toBe(404)

    const asked = await req(a.jar, 'POST', '/api/romance/duo', { matchId: match.id })
    expect(asked.status).toBe(200)
    expect(asked.data.status).toBe('PENDING')
    expect((await req(a.jar, 'POST', '/api/romance/duo', { matchId: match.id })).data.status).toBe('PENDING')
    const pendingA = (await duoOf(a)).data.duo
    const pendingB = (await duoOf(b)).data.duo
    expect(pendingA).toMatchObject({ status: 'PENDING', requestedByMe: true, partner: { id: b.userId }, shared: null })
    expect(pendingB).toMatchObject({ status: 'PENDING', requestedByMe: false, partner: { id: a.userId }, shared: null })
    expect(JSON.stringify(pendingA)).not.toMatch(/image|birth/)

    const formed = await req(b.jar, 'POST', '/api/romance/duo', { matchId: match.id })
    expect(formed.data.status).toBe('ACTIVE')
    expect((await duoOf(a)).data.duo.status).toBe('ACTIVE')
    expect((await duoOf(outsider)).data).toEqual({ duo: null })
    expect(await testPrisma.productEvent.count({ where: { userId: b.userId, name: 'romance_duo_formed' } })).toBe(1)
  }, 120_000)

  it('shares joint projects and a combined heatmap, and leaves out a partner who hides their activity', async () => {
    const a = await person('p')
    const b = await person('q')
    const match = await matchOf(a, b)
    const joint = await testPrisma.project.create({ data: { name: `Joint ${suffix}`, slug: `joint-${suffix}`, ownerId: a.userId, status: 'BUILDING', shortDesc: 'Built together' } })
    const solo = await testPrisma.project.create({ data: { name: `Solo ${suffix}`, slug: `solo-${suffix}`, ownerId: a.userId } })
    await testPrisma.projectMember.createMany({ data: [{ userId: a.userId, projectId: joint.id }, { userId: b.userId, projectId: joint.id }, { userId: a.userId, projectId: solo.id }] })
    const day = new Date()
    await testPrisma.xPEvent.create({ data: { userId: a.userId, type: 'PROJECT_CREATED', amount: 50, description: 'x', dedupeKey: `d1-${suffix}`, createdAt: day } })
    await testPrisma.xPEvent.create({ data: { userId: b.userId, type: 'PROJECT_CREATED', amount: 30, description: 'x', dedupeKey: `d2-${suffix}`, createdAt: day } })
    await req(a.jar, 'POST', '/api/romance/duo', { matchId: match.id })
    await req(b.jar, 'POST', '/api/romance/duo', { matchId: match.id })

    const page = (await duoOf(a)).data.duo
    expect(page.shared.projects.map((p: { id: string }) => p.id)).toEqual([joint.id])
    const today = day.toISOString().slice(0, 10)
    expect(page.shared.heatmap.items.find((i: { date: string }) => i.date === today)).toMatchObject({ xp: 80, actions: 2 })
    expect(page.shared.heatmap.partnerActivityHidden).toBe(false)

    await testPrisma.profile.create({ data: { userId: b.userId, showActivity: false } })
    const hidden = (await duoOf(a)).data.duo.shared.heatmap
    expect(hidden.partnerActivityHidden).toBe(true)
    expect(hidden.items.find((i: { date: string }) => i.date === today)).toMatchObject({ xp: 50, actions: 1 })
    await testPrisma.project.deleteMany({ where: { id: { in: [joint.id, solo.id] } } })
  }, 120_000)

  it('can be dissolved by either, at once, and asked for again', async () => {
    const a = await person('d')
    const b = await person('e')
    const match = await matchOf(a, b)
    await req(a.jar, 'POST', '/api/romance/duo', { matchId: match.id })
    await req(b.jar, 'POST', '/api/romance/duo', { matchId: match.id })
    expect((await req(b.jar, 'DELETE', '/api/romance/duo')).data).toEqual({ dissolved: true })
    expect((await duoOf(a)).data).toEqual({ duo: null })
    expect((await req(b.jar, 'DELETE', '/api/romance/duo')).data).toEqual({ dissolved: false })
    expect((await req(b.jar, 'POST', '/api/romance/duo', { matchId: match.id })).data.status).toBe('PENDING')
    // Declining a pending ask is the same call.
    expect((await req(a.jar, 'DELETE', '/api/romance/duo')).data).toEqual({ dissolved: true })
    expect((await duoOf(b)).data).toEqual({ duo: null })
  }, 120_000)

  it('is one at a time, and dissolved when the match ends', async () => {
    const a = await person('f')
    const b = await person('g')
    const c = await person('h')
    const ab = await matchOf(a, b)
    const ac = await matchOf(a, c)
    await req(a.jar, 'POST', '/api/romance/duo', { matchId: ab.id })
    await req(b.jar, 'POST', '/api/romance/duo', { matchId: ab.id })
    const busy = await req(a.jar, 'POST', '/api/romance/duo', { matchId: ac.id })
    expect(busy.status).toBe(409)
    expect(busy.data.error.code).toBe('DUO_BUSY')
    expect((await req(c.jar, 'POST', '/api/romance/duo', { matchId: ac.id })).status).toBe(409)
    expect((await req(a.jar, 'DELETE', `/api/matches/${ab.id}`)).status).toBe(200)
    expect((await duoOf(b)).data).toEqual({ duo: null })
    expect((await testPrisma.duo.findFirstOrThrow({ where: { userAId: pair(a.userId, b.userId)[0], userBId: pair(a.userId, b.userId)[1] } })).status).toBe('DISSOLVED')
    // An ended match cannot make a Duo, and neither can a professional one.
    expect((await req(b.jar, 'POST', '/api/romance/duo', { matchId: ab.id })).status).toBe(404)
    const pro = await matchOf(b, c, 'COFOUNDER')
    expect((await req(b.jar, 'POST', '/api/romance/duo', { matchId: pro.id })).status).toBe(404)
    // Now free to form another.
    expect((await req(c.jar, 'POST', '/api/romance/duo', { matchId: ac.id })).data.status).toBe('PENDING')
  }, 180_000)
})
