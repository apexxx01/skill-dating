import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { promoteToAdmin, cleanupTestUsers, testPrisma } from './db'

// Regression coverage for the two idempotency bugs actually caught live
// this session: an achievement/XP double-grant on a repeated action, and
// the hackathon-results double-award bug found and fixed in this same
// session (Phase 3 item 4).
describe('idempotency', () => {
  const suffix = uniqueSuffix()

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  it('does not double-grant an achievement or its XP on a repeated qualifying action', async () => {
    const user = await registerAndLogin(`idem.a.${suffix}@test.dev`, `idema${suffix}`)

    const first = await req(user.jar, 'POST', '/api/projects', { name: `Idem Project 1 ${suffix}` })
    expect(first.status).toBe(201)

    const second = await req(user.jar, 'POST', '/api/projects', { name: `Idem Project 2 ${suffix}` })
    expect(second.status).toBe(201)

    const achievement = await testPrisma.achievement.findUnique({ where: { slug: 'first-project' } })
    expect(achievement).toBeTruthy()

    const grants = await testPrisma.userAchievement.count({
      where: { userId: user.userId, achievementId: achievement!.id },
    })
    expect(grants).toBe(1)

    const xpEvents = await testPrisma.xPEvent.count({
      where: { userId: user.userId, type: 'ACHIEVEMENT_EARNED' },
    })
    // Only 'first-project' can have fired from two project creations - not 2.
    expect(xpEvents).toBe(1)

    const activityRows = await testPrisma.activity.count({
      where: { userId: user.userId, type: 'PROJECT_CREATED' },
    })
    // Activity logs every occurrence, unlike the achievement grant.
    expect(activityRows).toBe(2)
  })

  it('does not double-award hackathon win XP/activity on repeated results submission', async () => {
    const admin = await registerAndLogin(`idem.hackadmin.${suffix}@test.dev`, `idemhackadmin${suffix}`)
    await promoteToAdmin(admin.userId)

    let r = await req(admin.jar, 'POST', '/api/hackathons', {
      name: `Idem Hackathon ${suffix}`,
      description: 'test',
      startDate: new Date(Date.now() + 86400000).toISOString(),
      endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
    })
    const hackathonId = r.data.id

    r = await req(admin.jar, 'POST', `/api/hackathons/${hackathonId}`, { skills: [], lookingFor: [] })
    expect(r.status).toBe(201)

    r = await req(admin.jar, 'POST', '/api/projects', { name: `Idem Hack Project ${suffix}` })
    const projectId = r.data.id

    r = await req(admin.jar, 'POST', '/api/teams', { name: `Idem Hack Team ${suffix}`, projectId })
    const teamId = r.data.id

    r = await req(admin.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId, projectId })
    expect(r.status).toBe(200)
    const hackathonTeamId = r.data.hackathonTeamId

    await req(admin.jar, 'PATCH', `/api/hackathons/${hackathonId}`, { status: 'ACTIVE' })
    await req(admin.jar, 'PATCH', `/api/hackathons/${hackathonId}`, { status: 'ENDED' })

    const firstResult = await req(admin.jar, 'PATCH', `/api/hackathons/${hackathonId}/results`, {
      results: [{ hackathonTeamId, rank: 1, score: 100 }],
    })
    expect(firstResult.status).toBe(200)

    const secondResult = await req(admin.jar, 'PATCH', `/api/hackathons/${hackathonId}/results`, {
      results: [{ hackathonTeamId, rank: 1, score: 100 }],
    })
    expect(secondResult.status).toBe(200)

    const winXp = await testPrisma.xPEvent.count({ where: { userId: admin.userId, type: 'HACKATHON_WIN' } })
    expect(winXp).toBe(1)

    const wonActivity = await testPrisma.activity.count({ where: { userId: admin.userId, type: 'HACKATHON_WON' } })
    expect(wonActivity).toBe(1)
  })
})
