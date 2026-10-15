import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { ACHIEVEMENT_DEFINITIONS } from '../../src/lib/achievement-definitions'
import { MAX_REWARDED_ENDORSEMENTS_PER_ENDORSER_PER_DAY } from '../../src/lib/skill-evidence'
import { REWARD_RULES } from '../../src/lib/rewards-config'

// Being endorsed pays out XP and the `endorsed` achievement. That reward is the
// farmable part, so it only counts endorsements from verified accounts and is
// capped per endorser (here) and per recipient (by the rewards engine) per day. The endorsement itself
// still counts toward the evidence either way.
describe('endorsement rewards', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let skillId: string

  afterAll(async () => {
    await cleanupTestUsers(suffix)
    await testPrisma.skill.deleteMany({ where: { slug: `er-skill-${suffix}` } })
  })

  async function user(label: string): Promise<TestUser> {
    const name = `er${label}${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    // A Clerk account arrives with a verified email (and so at level EMAIL). These
    // tests are about accounts that have NOT proven anything yet, so put the row
    // back to that state; `verify` moves it up again where a test needs it.
    await testPrisma.user.update({ where: { id: u.userId }, data: { verificationLevel: 'NONE', isEmailVerified: false } })
    return u
  }

  async function skill() {
    if (!skillId) {
      skillId = (await testPrisma.skill.create({ data: { name: `Er Skill ${suffix}`, slug: `er-skill-${suffix}`, category: 'Test' } })).id
    }
    return skillId
  }

  async function evidenceFor(owner: TestUser): Promise<string> {
    const id = await skill()
    await testPrisma.userSkill.upsert({
      where: { userId_skillId: { userId: owner.userId, skillId: id } },
      update: {},
      create: { userId: owner.userId, skillId: id },
    })
    const res = await req(owner.jar, 'POST', '/api/evidence', { skillId: id, type: 'PORTFOLIO', title: `Work ${n++}`, url: 'https://example.com/x' })
    expect(res.status).toBe(201)
    return res.data.id
  }

  const verify = (u: TestUser) =>
    testPrisma.user.update({ where: { id: u.userId }, data: { verificationLevel: 'EMAIL', isEmailVerified: true } })

  const reward = async (u: TestUser) => ({
    achievement: await testPrisma.userAchievement.count({ where: { userId: u.userId, achievement: { slug: 'endorsed' } } }),
    xpEvents: await testPrisma.xPEvent.count({ where: { userId: u.userId, type: 'ACHIEVEMENT_EARNED', description: { contains: 'Vouched For' } } }),
  })

  it('counts the endorsement but pays no reward when both accounts are fresh and unverified', async () => {
    const owner = await user('o')
    const farmer = await user('f')
    expect((await testPrisma.user.findUnique({ where: { id: farmer.userId } }))!.verificationLevel).toBe('NONE')
    const id = await evidenceFor(owner)
    const xpBefore = (await testPrisma.user.findUnique({ where: { id: owner.userId } }))!.xp

    const res = await req(farmer.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(res.status).toBe(201)
    expect(res.data).toEqual({ endorsed: true, endorsementCount: 1 })

    expect(await reward(owner)).toEqual({ achievement: 0, xpEvents: 0 })
    expect((await testPrisma.user.findUnique({ where: { id: owner.userId } }))!.xp).toBe(xpBefore)
    // The owner is still told about it; only the reward is withheld.
    expect(await testPrisma.notification.count({ where: { userId: owner.userId, metadata: { path: ['kind'], equals: 'SKILL_EVIDENCE_ENDORSED' } } })).toBe(1)
  })

  it('pays the reward once the same endorser is verified, and only once', async () => {
    const owner = await user('o')
    const endorser = await user('e')
    const id = await evidenceFor(owner)

    await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(await reward(owner)).toEqual({ achievement: 0, xpEvents: 0 })

    await verify(endorser)
    await req(endorser.jar, 'DELETE', `/api/evidence/${id}/endorse`)
    expect((await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)).status).toBe(201)
    expect(await reward(owner)).toEqual({ achievement: 1, xpEvents: 1 })

    // Endorse, withdraw and endorse again: nothing further.
    await req(endorser.jar, 'DELETE', `/api/evidence/${id}/endorse`)
    await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(await reward(owner)).toEqual({ achievement: 1, xpEvents: 1 })
  })

  it('rewards a verified endorser', async () => {
    const owner = await user('o')
    const endorser = await user('e')
    await verify(endorser)
    const id = await evidenceFor(owner)
    expect((await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)).status).toBe(201)
    expect(await reward(owner)).toEqual({ achievement: 1, xpEvents: 1 })
    expect((await testPrisma.user.findUnique({ where: { id: owner.userId } }))!.xp).toBeGreaterThanOrEqual(ACHIEVEMENT_DEFINITIONS.endorsed.xpReward)
  })

  it('limits how many owners one verified endorser can pay out to per day', async () => {
    const endorser = await user('e')
    await verify(endorser)
    const attempts = MAX_REWARDED_ENDORSEMENTS_PER_ENDORSER_PER_DAY + 2

    // Owners and their evidence are created directly: only the endorsing is under test.
    const id = await skill()
    const owners: string[] = []
    for (let i = 0; i < attempts; i++) {
      const owner = await testPrisma.user.create({ data: { email: `er.bulk${i}.${suffix}@test.dev`, username: `erbulk${i}${suffix}`, name: `Bulk ${i}` } })
      const evidence = await testPrisma.skillEvidence.create({ data: { userId: owner.id, skillId: id, type: 'PORTFOLIO', title: `Bulk ${i}` } })
      owners.push(owner.id)
      expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence.id}/endorse`)).status).toBe(201)
    }

    const rewarded = await testPrisma.userAchievement.count({ where: { userId: { in: owners }, achievement: { slug: 'endorsed' } } })
    expect(rewarded).toBe(MAX_REWARDED_ENDORSEMENTS_PER_ENDORSER_PER_DAY)
    // Every endorsement still counted.
    expect(await testPrisma.skillEvidence.count({ where: { type: 'PEER_ENDORSEMENT', metadata: { path: ['endorserId'], equals: endorser.userId } } })).toBe(attempts)
  })

  it('caps the XP one owner can earn from endorsements per day', async () => {
    const owner = await user('o')
    const endorser = await user('e')
    await verify(endorser)
    const id = await evidenceFor(owner)

    // The owner was already paid the day's allowance for being endorsed.
    const cap = REWARD_RULES.EVIDENCE_ENDORSED.dailyCap!
    await testPrisma.xPEvent.createMany({
      data: Array.from({ length: cap }, (_, index) => ({
        userId: owner.userId,
        type: 'EVIDENCE_ENDORSED',
        amount: REWARD_RULES.EVIDENCE_ENDORSED.amount!,
        description: 'Had evidence endorsed',
        sourceType: 'ENDORSEMENT',
        sourceId: `earlier-${index}`,
        dedupeKey: `endorsement:earlier-${index}`,
      })),
    })

    expect((await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)).status).toBe(201)
    expect(await testPrisma.xPEvent.count({ where: { userId: owner.userId, type: 'EVIDENCE_ENDORSED' } })).toBe(cap)
  })

  it('pays the endorsement XP only for a verified endorser', async () => {
    const owner = await user('o')
    const endorser = await user('e')
    const id = await evidenceFor(owner)
    const paid = () => testPrisma.xPEvent.count({ where: { userId: owner.userId, type: 'EVIDENCE_ENDORSED' } })

    await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(await paid()).toBe(0)

    await verify(endorser)
    await req(endorser.jar, 'DELETE', `/api/evidence/${id}/endorse`)
    await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(await paid()).toBe(1)
  })
})
