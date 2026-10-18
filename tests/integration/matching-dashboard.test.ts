import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { makePerson, makeSkills, removePeople } from './matching-fixtures'

// The dashboard's builder recommendations use the matching engine's score (src/lib/matching/score.ts) and keep their shape.
describe('dashboard recommendations', () => {
  const suffix = uniqueSuffix()
  const tag = `dsh${suffix}`
  let me: TestUser
  let slugs: string[] = []

  beforeAll(async () => {
    slugs = await makeSkills(tag, ['ml', 'react'])
    me = await registerAndLogin(`${tag}.me@test.dev`, `${tag}me`)
    const [ml, react] = await Promise.all(slugs.map((slug) => testPrisma.skill.findUniqueOrThrow({ where: { slug } })))
    await testPrisma.userSkill.createMany({ data: [{ userId: me.userId, skillId: ml.id, level: 4 }, { userId: me.userId, skillId: react.id, level: 3 }] })
  }, 60_000)
  afterAll(async () => {
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { in: slugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  it('scores each recommended builder 0 to 100 with the skills you share, best first, in the same shape as before', async () => {
    const [ml, react] = slugs
    const close = await makePerson({ tag, profile: false, skills: [[ml, 4], [react, 3]] })
    const partial = await makePerson({ tag, profile: false, skills: [[ml, 1]] })
    const res = await req(me.jar, 'GET', '/api/dashboard')
    expect(res.status).toBe(200)
    const builders = res.data.recommendedBuilders as { id: string; compatibility: number; commonSkills: string[]; skills: unknown[] }[]
    const a = builders.find((b) => b.id === close.id)!
    const b = builders.find((b) => b.id === partial.id)!
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    for (const builder of [a, b]) {
      expect(Number.isInteger(builder.compatibility)).toBe(true)
      expect(builder.compatibility).toBeGreaterThanOrEqual(0)
      expect(builder.compatibility).toBeLessThanOrEqual(100)
      expect(Array.isArray(builder.commonSkills)).toBe(true)
      expect(Array.isArray(builder.skills)).toBe(true)
    }
    expect(a.commonSkills.sort()).toEqual([ml, react].sort())
    expect(b.commonSkills).toEqual([ml])
    expect(a.compatibility).toBeGreaterThan(b.compatibility)
    const order = builders.map((x) => x.compatibility)
    expect(order).toEqual([...order].sort((x, y) => y - x))
    for (const key of ['id', 'name', 'username', 'image', 'headline', 'builderRole', 'skills', 'compatibility', 'commonSkills']) expect(a, key).toHaveProperty(key)
  })

  it('leaves out people who are blocked, and does not mix dating into it', async () => {
    const [ml] = slugs
    const blocked = await makePerson({ tag, profile: false, skills: [[ml, 5]] })
    await testPrisma.block.create({ data: { blockerId: me.userId, blockedId: blocked.id } })
    const res = await req(me.jar, 'GET', '/api/dashboard')
    expect(res.data.recommendedBuilders.map((b: { id: string }) => b.id)).not.toContain(blocked.id)
    // The score is worked out for a plain collaboration, whatever the viewer chose for dating.
    await testPrisma.matchingProfile.upsert({ where: { userId: me.userId }, create: { userId: me.userId, connectionTypes: ['DATING'] }, update: { connectionTypes: ['DATING'] } })
    const again = await req(me.jar, 'GET', '/api/dashboard')
    expect(again.status).toBe(200)
    for (const builder of again.data.recommendedBuilders) expect(typeof builder.compatibility).toBe('number')
  })
})
