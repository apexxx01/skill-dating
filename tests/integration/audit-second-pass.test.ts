import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { grantAchievement } from '../../src/lib/achievements'

// Regression tests for the second audit pass over skill evidence, project
// progress, messaging depth, blocks and the rate limiter.
describe('second audit pass', () => {
  const suffix = uniqueSuffix()
  let n = 0

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  async function user(label: string): Promise<TestUser> {
    const name = `sp${label}${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  it('grants an achievement exactly once when one user is granted it by parallel transactions', async () => {
    // Called straight from transactions that do not touch the user row first,
    // as the project-update and milestone routes do: nothing else serialises
    // them, so the grant itself must be race-safe.
    const u = await user('par')
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => testPrisma.$transaction((tx) => grantAchievement(tx, u.userId, 'first-update')))
    )
    expect(results.filter((r) => r.status === 'rejected').map((r: any) => String(r.reason?.message).slice(0, 120))).toEqual([])
    expect(results.filter((r: any) => r.value?.granted === true)).toHaveLength(1)

    const achievement = await testPrisma.achievement.findUnique({ where: { slug: 'first-update' } })
    expect(await testPrisma.userAchievement.count({ where: { userId: u.userId, achievementId: achievement!.id } })).toBe(1)
    expect(await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'ACHIEVEMENT_EARNED' } })).toBe(1)
    expect(await testPrisma.activity.count({ where: { userId: u.userId, type: 'ACHIEVEMENT_EARNED' } })).toBe(1)
  })

  it('does not let a client bind a conversation to a team, project or hackathon, or add unknown users', async () => {
    const owner = await user('own')
    const stranger = await user('str')
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Sp Team ${suffix}${n++}` })
    const project = await req(owner.jar, 'POST', '/api/projects', { name: `Sp Project ${suffix}${n++}` })

    for (const body of [
      { type: 'TEAM', teamId: team.data.id, participantIds: [owner.userId] },
      { type: 'PROJECT', projectId: project.data.id, participantIds: [owner.userId] },
      { type: 'HACKATHON', hackathonId: 'anything', participantIds: [owner.userId] },
    ]) {
      const res = await req(stranger.jar, 'POST', '/api/conversations', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }

    const ghost = await req(stranger.jar, 'POST', '/api/conversations', { type: 'GROUP', name: 'x', participantIds: ['no-such-user'] })
    expect(ghost.status).toBe(400)

    // Plain direct and group conversations still work.
    expect((await req(stranger.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [owner.userId] })).status).toBe(201)
    const group = await req(stranger.jar, 'POST', '/api/conversations', { type: 'GROUP', name: 'crew', participantIds: [owner.userId] })
    expect(group.status).toBe(201)
    expect(group.data.teamId ?? null).toBeNull()

    // The team's own conversation is still the one created with the team.
    expect(await testPrisma.conversation.count({ where: { teamId: team.data.id } })).toBe(1)
  })
})
