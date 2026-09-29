import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'

// Block enforcement for the cross-user actions added after the first round:
// endorsing evidence, reacting inside a direct conversation, and reading
// another user's skills or evidence. Each is checked in both directions.
describe('blocking: evidence, reactions and user-scoped reads', () => {
  const suffix = uniqueSuffix()
  let n = 0

  afterAll(async () => {
    await testPrisma.skill.deleteMany({ where: { slug: { contains: suffix } } })
    await cleanupTestUsers(suffix)
  })

  async function user(label: string): Promise<TestUser> {
    const name = `bi${label}${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  async function ownerWithEvidence() {
    const owner = await user('o')
    const skill = await testPrisma.skill.create({
      data: { name: `Bi Skill ${suffix}${n++}`, slug: `bi-skill-${suffix}-${n}`, category: 'Test' },
    })
    await testPrisma.userSkill.create({ data: { userId: owner.userId, skillId: skill.id, level: 3 } })
    const created = await req(owner.jar, 'POST', '/api/evidence', {
      skillId: skill.id,
      type: 'PORTFOLIO',
      title: 'Portfolio piece',
      url: 'https://example.com/work',
    })
    expect(created.status).toBe(201)
    return { owner, evidenceId: created.data.id as string }
  }

  it('refuses endorsements in both directions, allows unendorsing, and works again after unblocking', async () => {
    const { owner, evidenceId } = await ownerWithEvidence()
    const endorser = await user('e')

    const first = await req(endorser.jar, 'POST', `/api/evidence/${evidenceId}/endorse`)
    expect(first.status).toBe(201)

    await req(owner.jar, 'POST', '/api/blocks', { userId: endorser.userId })
    const other = await user('e2')

    // Blocked by the evidence owner: looks like the evidence does not exist.
    const fromBlocked = await req(endorser.jar, 'POST', `/api/evidence/${evidenceId}/endorse`)
    expect(fromBlocked.status).toBe(404)
    // The blocker is told plainly when they try to endorse the blocked user's work.
    const { evidenceId: blockedUsersEvidence, owner: blockedOwner } = await ownerWithEvidence()
    await req(other.jar, 'POST', '/api/blocks', { userId: blockedOwner.userId })
    const fromBlocker = await req(other.jar, 'POST', `/api/evidence/${blockedUsersEvidence}/endorse`)
    expect(fromBlocker.status).toBe(403)

    // Withdrawing an existing endorsement is never blocked.
    const withdraw = await req(endorser.jar, 'DELETE', `/api/evidence/${evidenceId}/endorse`)
    expect(withdraw.status).toBe(200)
    expect(withdraw.data.endorsementCount).toBe(0)

    await req(owner.jar, 'DELETE', `/api/blocks/${endorser.userId}`)
    expect((await req(endorser.jar, 'POST', `/api/evidence/${evidenceId}/endorse`)).status).toBe(201)
  })

  it('refuses reactions in a direct conversation in both directions but not in a shared room', async () => {
    const a = await user('a')
    const b = await user('b')
    const connection = await req(a.jar, 'POST', '/api/connections', { receiverId: b.userId, type: 'NETWORK' })
    await req(b.jar, 'PATCH', `/api/connections/${connection.data.id}`, { status: 'ACCEPTED' })
    const dm = await testPrisma.conversation.findFirst({
      where: { type: 'DIRECT', members: { some: { userId: a.userId } } },
    })
    const message = await req(a.jar, 'POST', `/api/conversations/${dm!.id}`, { content: 'hello' })
    expect(message.status).toBe(201)
    expect((await req(b.jar, 'POST', `/api/messages/${message.data.id}/reactions`, { emoji: '👍' })).status).toBe(200)

    await req(a.jar, 'POST', '/api/blocks', { userId: b.userId })
    expect((await req(b.jar, 'POST', `/api/messages/${message.data.id}/reactions`, { emoji: '🎉' })).status).toBe(404)
    expect((await req(a.jar, 'POST', `/api/messages/${message.data.id}/reactions`, { emoji: '🎉' })).status).toBe(403)

    // A shared team room the same pair is in stays open.
    const team = await req(a.jar, 'POST', '/api/teams', { name: `Bi Room ${suffix}${n++}` })
    await testPrisma.teamMember.create({ data: { teamId: team.data.id, userId: b.userId, role: 'MEMBER' } })
    const room = await testPrisma.conversation.findUnique({ where: { teamId: team.data.id } })
    await testPrisma.conversationMember.create({ data: { conversationId: room!.id, userId: b.userId } })
    const roomMessage = await req(a.jar, 'POST', `/api/conversations/${room!.id}`, { content: 'team chat' })
    expect((await req(b.jar, 'POST', `/api/messages/${roomMessage.data.id}/reactions`, { emoji: '👍' })).status).toBe(200)
  })

  it('hides a blocker\'s skills and evidence from the blocked user, and keeps them visible to the blocker', async () => {
    const { owner, evidenceId } = await ownerWithEvidence()
    const viewer = await user('v')

    expect((await req(viewer.jar, 'GET', `/api/users/${owner.userId}/skills`)).status).toBe(200)
    const before = await req(viewer.jar, 'GET', `/api/evidence?userId=${owner.userId}`)
    expect(before.data.evidence.map((e: any) => e.id)).toContain(evidenceId)

    await req(owner.jar, 'POST', '/api/blocks', { userId: viewer.userId })
    expect((await req(viewer.jar, 'GET', `/api/users/${owner.userId}/skills`)).status).toBe(404)
    expect((await req(viewer.jar, 'GET', `/api/evidence?userId=${owner.userId}`)).status).toBe(404)

    // The blocker can still see the blocked user's.
    await req(viewer.jar, 'POST', '/api/blocks', { userId: owner.userId })
    await req(owner.jar, 'DELETE', `/api/blocks/${viewer.userId}`)
    expect((await req(owner.jar, 'GET', `/api/users/${viewer.userId}/skills`)).status).toBe(404)
    expect((await req(viewer.jar, 'GET', `/api/users/${owner.userId}/skills`)).status).toBe(200)
  })
})
