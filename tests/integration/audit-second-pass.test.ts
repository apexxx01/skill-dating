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
})
