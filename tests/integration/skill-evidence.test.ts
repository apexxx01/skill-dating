import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'

const BCRYPT_HASH = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/

describe('skill evidence and endorsements', () => {
  const suffix = uniqueSuffix()
  const emails = {
    owner: `evid.owner.${suffix}@test.dev`,
    endorser: `evid.endorser.${suffix}@test.dev`,
    other: `evid.other.${suffix}@test.dev`,
    third: `evid.third.${suffix}@test.dev`,
  }
  let owner: TestUser
  let endorser: TestUser
  let other: TestUser
  let third: TestUser
  let forger: TestUser
  let skillId: string
  const responses: string[] = []

  const track = <T extends { data: unknown }>(r: T): T => {
    responses.push(JSON.stringify(r.data))
    return r
  }

  const validBody = (over: Record<string, unknown> = {}) => ({
    skillId,
    type: 'GITHUB_PROJECT',
    title: 'My repo',
    url: 'https://github.com/example/repo',
    ...over,
  })

  // Fixture evidence goes straight into the database: the create endpoint is
  // limited to 20 requests a minute per user (rejected ones count too), so the
  // tests that are not about creation must not spend that budget.
  const createEvidence = async (user: TestUser = owner, over: Record<string, unknown> = {}) => {
    const row = await testPrisma.skillEvidence.create({
      data: { userId: user.userId, skillId, type: 'GITHUB_PROJECT', title: 'My repo', url: 'https://github.com/example/repo', ...over },
    })
    return row.id
  }

  const createEvidenceViaApi = async (user: TestUser = owner, over: Record<string, unknown> = {}) => {
    const r = track(await req(user.jar, 'POST', '/api/evidence', validBody(over)))
    expect(r.status).toBe(201)
    return r.data.id as string
  }

  const endorsementRows = (evidenceId: string) =>
    testPrisma.skillEvidence.count({
      where: { type: 'PEER_ENDORSEMENT', metadata: { path: ['endorsedEvidenceId'], equals: evidenceId } },
    })

  beforeAll(async () => {
    owner = await registerAndLogin(emails.owner, `evidowner${suffix}`)
    endorser = await registerAndLogin(emails.endorser, `evidendorser${suffix}`)
    other = await registerAndLogin(emails.other, `evidother${suffix}`)
    third = await registerAndLogin(emails.third, `evidthird${suffix}`)
    forger = await registerAndLogin(`evid.forger.${suffix}@test.dev`, `evidforger${suffix}`)

    // Endorsement rewards need a verified endorser; that rule has its own tests
    // (endorsement-rewards.test.ts), here the accounts that endorse are verified.
    await testPrisma.user.updateMany({
      where: { id: { in: [endorser.userId, other.userId, third.userId] } },
      data: { verificationLevel: 'EMAIL', isEmailVerified: true },
    })

    const skill = await testPrisma.skill.create({
      data: { name: `Evidence Skill ${suffix}`, slug: `evidence-skill-${suffix}`, category: 'Test' },
    })
    skillId = skill.id
    await testPrisma.userSkill.createMany({ data: [{ userId: owner.userId, skillId }, { userId: forger.userId, skillId }] })
  })

  afterAll(async () => {
    await cleanupTestUsers(suffix)
    await testPrisma.skill.deleteMany({ where: { slug: `evidence-skill-${suffix}` } })
  })

  it('requires authentication', async () => {
    expect((await req(null, 'GET', '/api/evidence')).status).toBe(401)
    expect((await req(null, 'POST', '/api/evidence', validBody())).status).toBe(401)
  })

  it('creates, lists and deletes own evidence', async () => {
    const id = await createEvidenceViaApi(owner, { title: 'Listed repo' })

    const list = track(await req(owner.jar, 'GET', `/api/evidence?skillId=${skillId}`))
    expect(list.status).toBe(200)
    const item = list.data.evidence.find((e: any) => e.id === id)
    expect(item).toMatchObject({ title: 'Listed repo', type: 'GITHUB_PROJECT', endorsementCount: 0, endorsedByMe: false })
    expect(item.verifiedAt).toBeNull()
    expect(list.data.pagination.total).toBeGreaterThanOrEqual(1)

    // Someone else's list shows the same public evidence.
    const theirs = track(await req(other.jar, 'GET', `/api/evidence?userId=${owner.userId}`))
    expect(theirs.data.evidence.some((e: any) => e.id === id)).toBe(true)

    const del = await req(owner.jar, 'DELETE', `/api/evidence/${id}`)
    expect(del.status).toBe(200)
    expect(await testPrisma.skillEvidence.count({ where: { id } })).toBe(0)
  })

  it('returns 404 when listing a user that does not exist', async () => {
    expect((await req(owner.jar, 'GET', '/api/evidence?userId=no-such-user')).status).toBe(404)
  })

  it('grants first-evidence once and records an activity per creation', async () => {
    const before = await testPrisma.activity.count({ where: { userId: owner.userId, type: 'SKILL_EVIDENCE_ADDED' } })
    await createEvidenceViaApi(owner)
    await createEvidenceViaApi(owner)
    const after = await testPrisma.activity.count({ where: { userId: owner.userId, type: 'SKILL_EVIDENCE_ADDED' } })
    expect(after - before).toBe(2)

    const grants = await testPrisma.userAchievement.count({
      where: { userId: owner.userId, achievement: { slug: 'first-evidence' } },
    })
    expect(grants).toBe(1)
  })

  it('refuses evidence for a skill the caller does not hold', async () => {
    const r = await req(third.jar, 'POST', '/api/evidence', validBody())
    expect(r.status).toBe(400)
    expect(await testPrisma.skillEvidence.count({ where: { userId: third.userId } })).toBe(0)

    const missing = await req(owner.jar, 'POST', '/api/evidence', validBody({ skillId: 'does-not-exist' }))
    expect(missing.status).toBe(400)
  })

  it('cannot forge platform-controlled types or fields', async () => {
    const before = await testPrisma.skillEvidence.count({ where: { userId: forger.userId } })
    const attempts = [
      validBody({ type: 'PEER_ENDORSEMENT' }),
      validBody({ type: 'CHALLENGE' }),
      validBody({ type: 'CONNECTED_PROFILE' }),
      validBody({ verifiedAt: new Date().toISOString() }),
      validBody({ metadata: { endorsedEvidenceId: 'x', endorserId: endorser.userId } }),
      validBody({ userId: endorser.userId }),
    ]
    for (const body of attempts) {
      const r = await req(forger.jar, 'POST', '/api/evidence', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect(await testPrisma.skillEvidence.count({ where: { userId: forger.userId } })).toBe(before)
  })

  it('accepts only http(s) URLs and bounds field lengths', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.com/a', 'not a url']) {
      const r = await req(forger.jar, 'POST', '/api/evidence', validBody({ url }))
      expect(r.status, url).toBe(400)
    }
    expect((await req(forger.jar, 'POST', '/api/evidence', validBody({ title: 'x'.repeat(201) }))).status).toBe(400)
    expect((await req(forger.jar, 'POST', '/api/evidence', validBody({ description: 'x'.repeat(2001) }))).status).toBe(400)
    expect((await req(forger.jar, 'POST', '/api/evidence', validBody({ title: '   ' }))).status).toBe(400)

    const ok = await req(forger.jar, 'POST', '/api/evidence', validBody({ url: 'http://example.com/portfolio', type: 'PORTFOLIO' }))
    expect(ok.status).toBe(201)
  })

  it('caps evidence per skill', async () => {
    const capUser = await registerAndLogin(`evid.cap.${suffix}@test.dev`, `evidcap${suffix}`)
    await testPrisma.userSkill.create({ data: { userId: capUser.userId, skillId } })
    await testPrisma.skillEvidence.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        userId: capUser.userId,
        skillId,
        type: 'PORTFOLIO',
        title: `seeded ${i}`,
      })),
    })
    const r = await req(capUser.jar, 'POST', '/api/evidence', validBody())
    expect(r.status).toBe(400)
    expect(await testPrisma.skillEvidence.count({ where: { userId: capUser.userId } })).toBe(20)
  })

  it("does not let another user delete someone's evidence", async () => {
    const id = await createEvidence()
    const r = await req(other.jar, 'DELETE', `/api/evidence/${id}`)
    expect(r.status).toBe(403)
    expect(await testPrisma.skillEvidence.count({ where: { id } })).toBe(1)
  })

  it('rejects self-endorsement', async () => {
    const id = await createEvidence()
    const r = await req(owner.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(r.status).toBe(403)
    expect(await endorsementRows(id)).toBe(0)
  })

  it('endorses idempotently and reports counts to owner and endorser', async () => {
    const id = await createEvidence()

    const first = track(await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`))
    expect(first.status).toBe(201)
    expect(first.data).toEqual({ endorsed: true, endorsementCount: 1 })

    const repeat = track(await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`))
    expect(repeat.status).toBe(200)
    expect(repeat.data).toEqual({ endorsed: true, endorsementCount: 1 })
    expect(await endorsementRows(id)).toBe(1)

    const asEndorser = track(await req(endorser.jar, 'GET', `/api/evidence?userId=${owner.userId}`))
    expect(asEndorser.data.evidence.find((e: any) => e.id === id)).toMatchObject({ endorsementCount: 1, endorsedByMe: true })
    const asOwner = track(await req(owner.jar, 'GET', '/api/evidence'))
    expect(asOwner.data.evidence.find((e: any) => e.id === id)).toMatchObject({ endorsementCount: 1, endorsedByMe: false })

    // Endorsement rows never appear as evidence in the list.
    expect(asOwner.data.evidence.every((e: any) => e.type !== 'PEER_ENDORSEMENT')).toBe(true)
  })

  it('creates exactly one endorsement under parallel endorse calls', async () => {
    const id = await createEvidence()
    const rivals = await registerAndLogin(`evid.rival.${suffix}@test.dev`, `evidrival${suffix}`)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => req(rivals.jar, 'POST', `/api/evidence/${id}/endorse`))
    )
    const statuses = results.map((r) => r.status).sort()
    expect(statuses.every((s) => s === 200 || s === 201)).toBe(true)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(await endorsementRows(id)).toBe(1)
  })

  it('does not double-award or double-notify on unendorse then re-endorse, and grants endorsed once', async () => {
    const ownerB = await registerAndLogin(`evid.ownerb.${suffix}@test.dev`, `evidownerb${suffix}`)
    await testPrisma.userSkill.create({ data: { userId: ownerB.userId, skillId } })
    const id = await createEvidence(ownerB)

    const kind = { path: ['kind'], equals: 'SKILL_EVIDENCE_ENDORSED' }
    const counts = async () => ({
      rows: await endorsementRows(id),
      activity: await testPrisma.activity.count({ where: { userId: ownerB.userId, type: 'SKILL_EVIDENCE_ENDORSED' } }),
      notifications: await testPrisma.notification.count({ where: { userId: ownerB.userId, metadata: kind } }),
      achievement: await testPrisma.userAchievement.count({
        where: { userId: ownerB.userId, achievement: { slug: 'endorsed' } },
      }),
      achievementXp: await testPrisma.xPEvent.count({ where: { userId: ownerB.userId, type: 'ACHIEVEMENT_EARNED', description: { contains: 'Vouched For' } } }),
    })

    expect((await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)).status).toBe(201)
    expect(await counts()).toEqual({ rows: 1, activity: 1, notifications: 1, achievement: 1, achievementXp: 1 })

    const un = track(await req(endorser.jar, 'DELETE', `/api/evidence/${id}/endorse`))
    expect(un.status).toBe(200)
    expect(un.data).toEqual({ endorsed: false, endorsementCount: 0 })
    expect((await counts()).rows).toBe(0)

    // Unendorse is idempotent.
    expect((await req(endorser.jar, 'DELETE', `/api/evidence/${id}/endorse`)).status).toBe(200)

    expect((await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)).status).toBe(201)
    expect(await counts()).toEqual({ rows: 1, activity: 1, notifications: 1, achievement: 1, achievementXp: 1 })

    // A different endorser is a new event, but the achievement and its XP stay single.
    expect((await req(other.jar, 'POST', `/api/evidence/${id}/endorse`)).status).toBe(201)
    expect(await counts()).toEqual({ rows: 2, activity: 2, notifications: 2, achievement: 1, achievementXp: 1 })
  })

  it('does not treat an endorsement row as endorsable or deletable evidence', async () => {
    const id = await createEvidence()
    await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)
    const row = await testPrisma.skillEvidence.findFirst({
      where: { type: 'PEER_ENDORSEMENT', metadata: { path: ['endorsedEvidenceId'], equals: id } },
    })
    expect(row).toBeTruthy()

    expect((await req(other.jar, 'POST', `/api/evidence/${row!.id}/endorse`)).status).toBe(404)
    expect((await req(owner.jar, 'DELETE', `/api/evidence/${row!.id}`)).status).toBe(404)
    expect((await req(endorser.jar, 'DELETE', `/api/evidence/${row!.id}/endorse`)).status).toBe(404)
    expect(await testPrisma.skillEvidence.count({ where: { id: row!.id } })).toBe(1)
  })

  it('removes endorsements together with the evidence they point at', async () => {
    const id = await createEvidence()
    await req(endorser.jar, 'POST', `/api/evidence/${id}/endorse`)
    expect(await endorsementRows(id)).toBe(1)
    expect((await req(owner.jar, 'DELETE', `/api/evidence/${id}`)).status).toBe(200)
    expect(await endorsementRows(id)).toBe(0)
  })

  it('answers garbage ids with a clean 404, never a 500', async () => {
    const garbage = ['not-a-real-id', 'x'.repeat(500), encodeURIComponent("'; DROP TABLE \"SkillEvidence\";--"), '%E2%9C%93']
    for (const id of garbage) {
      for (const [method, suffixPath] of [['DELETE', ''], ['POST', '/endorse'], ['DELETE', '/endorse']] as const) {
        const r = await req(endorser.jar, method, `/api/evidence/${id}${suffixPath}`)
        expect(r.status, `${method} ${id.slice(0, 20)}${suffixPath}`).toBe(404)
      }
    }
  })

  it('never puts an email address or password hash in a response', async () => {
    expect(responses.length).toBeGreaterThan(0)
    for (const body of responses) {
      expect(body).not.toContain('passwordHash')
      expect(body).not.toMatch(BCRYPT_HASH)
      for (const email of Object.values(emails)) expect(body).not.toContain(email)
    }
  })
})
