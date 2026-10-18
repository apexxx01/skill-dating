import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { makePerson, makeSkills, removePeople } from './matching-fixtures'

// /api/discover, /api/teams/{id}/candidates and the profile read score with the matching engine (src/lib/matching/score.ts), keep their shapes
// and now say why.
describe('one scoring on every surface', () => {
  const suffix = uniqueSuffix()
  const tag = `ms${suffix}`
  let me: TestUser
  let slugs: string[] = []

  beforeAll(async () => {
    slugs = await makeSkills(tag, ['ml', 'react', 'rust'])
    me = await registerAndLogin(`${tag}.me@test.dev`, `${tag}me`)
    const [ml, react] = await Promise.all(slugs.slice(0, 2).map((slug) => testPrisma.skill.findUniqueOrThrow({ where: { slug } })))
    await testPrisma.userSkill.createMany({ data: [{ userId: me.userId, skillId: ml.id, level: 4 }, { userId: me.userId, skillId: react.id, level: 3 }] })
  }, 60_000)
  afterAll(async () => {
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { in: slugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  it('discover ranks by the matching score, keeps its fields and adds reasons', async () => {
    const [ml, react] = slugs
    const close = await makePerson({ tag, profile: false, skills: [[ml, 4], [react, 3]] })
    const far = await makePerson({ tag, profile: false })
    const res = await req(me.jar, 'GET', `/api/discover?search=${tag}&limit=50`)
    expect(res.status).toBe(200)
    const people = res.data.people as { id: string; compatibility: number; reasons: string[] }[]
    const a = people.find((p) => p.id === close.id)!
    const b = people.find((p) => p.id === far.id)!
    expect(Number.isInteger(a.compatibility) && a.compatibility <= 100).toBe(true)
    expect(a.compatibility).toBeGreaterThan(b.compatibility)
    expect(a.reasons.some((line) => line.startsWith('You both know'))).toBe(true)
    expect(a.reasons.length).toBeLessThanOrEqual(3)
    expect(b.reasons).toEqual([])
    const order = people.map((p) => p.compatibility)
    expect(order).toEqual([...order].sort((x, y) => y - x))
    for (const key of ['id', 'name', 'username', 'image', 'headline', 'location', 'builderRole', 'xp', 'skills', 'compatibility']) expect(a, key).toHaveProperty(key)
    expect(res.data.pagination).toBeDefined()
  })

  it('the profile read gives the same score and the reasons, and nothing on your own', async () => {
    const [ml, react] = slugs
    const other = await makePerson({ tag, profile: false, skills: [[ml, 4], [react, 3]] })
    const res = await req(me.jar, 'GET', `/api/users/${other.id}`)
    expect(res.status).toBe(200)
    const discover = await req(me.jar, 'GET', `/api/discover?search=${other.username}`)
    expect(res.data.compatibility).toBe(discover.data.people.find((p: { id: string }) => p.id === other.id).compatibility)
    expect(res.data.compatibilityReasons.length).toBeGreaterThan(0)
    const own = await req(me.jar, 'GET', `/api/users/${me.userId}`)
    expect(own.data.compatibility).toBeNull()
    expect(own.data.compatibilityReasons).toEqual([])
  })

  it('team candidates score the team as a viewer, keep their shape and say why', async () => {
    const [ml, , rust] = slugs
    const needed = await testPrisma.skill.findUniqueOrThrow({ where: { slug: rust } })
    const has = await makePerson({ tag, profile: false, skills: [[rust, 5]] })
    const weaker = await makePerson({ tag, profile: false, skills: [[rust, 1]] })
    const team = await req(me.jar, 'POST', '/api/teams', { name: `Surf ${tag}`, lookingFor: [needed.name] })
    expect(team.status).toBe(201)
    const res = await req(me.jar, 'GET', `/api/teams/${team.data.id}/candidates`)
    expect(res.status).toBe(200)
    const candidates = res.data.candidates as { id: string; compatibility: number; matchedSkills: string[]; reasons: string[] }[]
    const a = candidates.find((c) => c.id === has.id)!
    const b = candidates.find((c) => c.id === weaker.id)!
    expect(a.matchedSkills).toEqual([needed.name])
    expect(a.compatibility).toBeGreaterThan(b.compatibility)
    expect(a.reasons.some((line) => line.includes('You need'))).toBe(true)
    for (const key of ['id', 'name', 'username', 'image', 'headline', 'builderRole', 'xp', 'rank', 'location', 'compatibility', 'matchedSkills']) expect(a, key).toHaveProperty(key)
    expect(res.data.nextCursor).toBeNull()
    expect(ml).toBeDefined()
  })
})
