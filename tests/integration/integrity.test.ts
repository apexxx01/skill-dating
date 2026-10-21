import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, establishAccount, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

// Integrity: the nightly collusion run finds a ring of young accounts boosting each other, lowers the weight of what they gave each other (never
// deleting it), and an admin's dismissal restores it all; the risk run scores the members; an override is audited; and reach gating keeps an account
// without a verified email off the public feed.
describe('integrity: collusion, risk and reach', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let member: TestUser
  let ring: string[] = []
  let outsiderId: string
  let skillId: string
  const posts: Record<string, string> = {}

  async function dbUser(tag: string, ageDays: number) {
    return testPrisma.user.create({
      data: { email: `${tag}${suffix}@test.dev`, username: `${tag}${suffix}`.slice(0, 30), isEmailVerified: true, createdAt: new Date(Date.now() - ageDays * 86_400_000) },
    })
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`ina${suffix}@test.dev`, `ina${suffix}`)
    await promoteToAdmin(admin.userId)
    member = await registerAndLogin(`inm${suffix}@test.dev`, `inm${suffix}`)
    ring = (await Promise.all(['ra', 'rb', 'rc', 'rd'].map((tag) => dbUser(tag, 3)))).map((u) => u.id)
    outsiderId = (await dbUser('old', 400)).id
    skillId = (await testPrisma.skill.create({ data: { name: `Ring skill ${suffix}`, slug: `ring-skill-${suffix}`, category: 'test' } })).id

    // Everybody in the ring endorses and gives Props to everybody else; an established outsider gives one Prop too.
    for (const id of [...ring, outsiderId]) {
      posts[id] = (await testPrisma.shipPost.create({ data: { authorId: id, kind: 'UPDATE', title: 'Ring post', body: 'x', propsScore: 0 } })).id
    }
    for (const from of ring) {
      for (const to of ring) {
        if (from === to) continue
        await testPrisma.skillEvidence.create({ data: { userId: to, skillId, type: 'PEER_ENDORSEMENT', title: 'Endorsed', metadata: { endorsedEvidenceId: `e-${to}`, endorserId: from } } })
        await testPrisma.prop.create({ data: { userId: from, postId: posts[to], weight: 1 } })
      }
    }
    await testPrisma.prop.create({ data: { userId: outsiderId, postId: posts[ring[0]], weight: 1 } })
    for (const id of ring) await testPrisma.shipPost.update({ where: { id: posts[id] }, data: { propsScore: id === ring[0] ? 4 : 3, propsCount: id === ring[0] ? 4 : 3 } })
  }, 120_000)

  afterAll(async () => {
    await testPrisma.fraudSignal.deleteMany({ where: { memberIds: { hasSome: ring } } })
    await testPrisma.skill.deleteMany({ where: { id: skillId } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('flags the ring and lowers what its members gave each other, without deleting anything', async () => {
    expect((await req(member.jar, 'POST', '/api/admin/jobs/integrity/collusion', {})).status).toBe(403)
    const run = await req(admin.jar, 'POST', '/api/admin/jobs/integrity/collusion', {})
    expect(run.status).toBe(200)

    const signal = await testPrisma.fraudSignal.findFirstOrThrow({ where: { memberIds: { hasEvery: ring } } })
    expect(signal).toMatchObject({ type: 'COLLUSION_RING', status: 'OPEN' })
    expect(signal.memberIds.sort()).toEqual([...ring].sort())
    expect(signal.score).toBeGreaterThanOrEqual(80)
    expect((signal.evidence as any).counts).toMatchObject({ ENDORSEMENT: 12, PROP: 12 })

    const ringProps = await testPrisma.prop.findMany({ where: { userId: { in: ring } } })
    expect(ringProps).toHaveLength(12)
    for (const prop of ringProps) expect(prop.integrityWeight).toBeLessThan(0.5)
    // The outsider's Prop is untouched; the score is recomputed from the weights.
    expect((await testPrisma.prop.findFirstOrThrow({ where: { userId: outsiderId } })).integrityWeight).toBe(1)
    const post = await testPrisma.shipPost.findUniqueOrThrow({ where: { id: posts[ring[0]] } })
    expect(post.propsCount).toBe(4)
    expect(post.propsScore).toBeCloseTo(1 + 3 * ringProps[0].integrityWeight, 2)
    const endorsements = await testPrisma.skillEvidence.findMany({ where: { skillId } })
    expect(endorsements).toHaveLength(12)
    for (const row of endorsements) expect(row.integrityWeight).toBeLessThan(0.5)

    // A second run updates the same signal rather than writing another.
    await req(admin.jar, 'POST', '/api/admin/jobs/integrity/collusion', {})
    expect(await testPrisma.fraudSignal.count({ where: { memberIds: { hasEvery: ring } } })).toBe(1)
  })

  it('lists signals to staff only', async () => {
    expect((await req(member.jar, 'GET', '/api/admin/fraud-signals')).status).toBe(403)
    const list = await req(admin.jar, 'GET', '/api/admin/fraud-signals?status=OPEN')
    expect(list.status).toBe(200)
    expect(list.data.signals.some((s: any) => s.memberIds.includes(ring[0]))).toBe(true)
  })

  it('scores the members, and lets staff override a level with an audit trail', async () => {
    expect((await req(admin.jar, 'POST', '/api/admin/jobs/integrity/risk', {})).status).toBe(200)
    const risk = await testPrisma.userRisk.findUniqueOrThrow({ where: { userId: ring[0] } })
    expect((risk.factors as any).collusion).toBeGreaterThanOrEqual(30)

    expect((await req(member.jar, 'PATCH', `/api/admin/users/${member.userId}/risk`, { level: 'HIGH', reason: 'test' })).status).toBe(403)
    const set = await req(admin.jar, 'PATCH', `/api/admin/users/${member.userId}/risk`, { level: 'HIGH', reason: 'Spam wave from this account' })
    expect(set.status).toBe(200)
    expect(set.data.effectiveLevel).toBe('HIGH')
    expect(await testPrisma.auditEvent.count({ where: { action: 'RISK_OVERRIDDEN', targetId: member.userId } })).toBe(1)

    // Reduced reach: a high-risk member's public post does not reach a stranger's feed.
    const posted = await req(member.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Hello there', body: 'A post from a high risk account' })
    expect(posted.status).toBe(201)
    const feed = await req(admin.jar, 'GET', '/api/feed?tab=for-you')
    expect(feed.status).toBe(200)
    expect(feed.data.posts.map((p: any) => p.id)).not.toContain(posted.data.post.id)

    const cleared = await req(admin.jar, 'PATCH', `/api/admin/users/${member.userId}/risk`, { level: null, reason: 'Reviewed, fine' })
    expect(cleared.data.effectiveLevel).toBe('LOW')
  })

  it('restores every lowered weight when the signal is dismissed, and does not flag the group again', async () => {
    const signal = await testPrisma.fraudSignal.findFirstOrThrow({ where: { memberIds: { hasEvery: ring } } })
    expect((await req(member.jar, 'PATCH', `/api/admin/fraud-signals/${signal.id}`, { status: 'DISMISSED' })).status).toBe(403)
    const dismissed = await req(admin.jar, 'PATCH', `/api/admin/fraud-signals/${signal.id}`, { status: 'DISMISSED', note: 'A real study group' })
    expect(dismissed.data.status).toBe('DISMISSED')
    for (const prop of await testPrisma.prop.findMany({ where: { userId: { in: ring } } })) expect(prop.integrityWeight).toBe(1)
    for (const row of await testPrisma.skillEvidence.findMany({ where: { skillId } })) expect(row.integrityWeight).toBe(1)
    expect((await testPrisma.shipPost.findUniqueOrThrow({ where: { id: posts[ring[0]] } })).propsScore).toBeCloseTo(4, 2)
    expect(await testPrisma.auditEvent.count({ where: { action: 'FRAUD_SIGNAL_DISMISSED', targetId: signal.id } })).toBe(1)

    await req(admin.jar, 'POST', '/api/admin/jobs/integrity/collusion', {})
    expect((await testPrisma.fraudSignal.findUniqueOrThrow({ where: { id: signal.id } })).status).toBe('DISMISSED')
    expect((await testPrisma.prop.findFirstOrThrow({ where: { userId: ring[1] } })).integrityWeight).toBe(1)
    expect((await req(admin.jar, 'PATCH', '/api/admin/fraud-signals/nope', { status: 'CONFIRMED' })).data.error.code).toBe('FRAUD_SIGNAL_NOT_FOUND')
  })

  it('keeps an account without a verified email off the public feed, and lets it post to followers', async () => {
    await establishAccount(member.userId, { verified: false })
    const pub = await req(member.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Public', body: 'For everyone' })
    expect(pub.status).toBe(403)
    expect(pub.data.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    expect((await req(member.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Followers', body: 'For followers', visibility: 'FOLLOWERS' })).status).toBe(201)
    await establishAccount(member.userId)
  })
})
