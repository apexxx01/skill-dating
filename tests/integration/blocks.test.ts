import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'

// A block is stored directionally but enforced symmetrically. Every check
// below is run in BOTH directions: the person who placed the block is told
// plainly (403), the person who was blocked sees an ordinary "not found" (404)
// so that being blocked is not revealed to them.
describe('blocking', () => {
  const suffix = uniqueSuffix()
  let n = 0
  const nextName = (label: string) => `blk${label}${suffix}${n++}`

  afterAll(async () => {
    await testPrisma.skill.deleteMany({ where: { slug: { contains: suffix } } })
    await cleanupTestUsers(suffix)
  })

  async function pair(): Promise<{ a: TestUser; b: TestUser; nameB: string }> {
    const nameA = nextName('a')
    const nameB = nextName('b')
    const a = await registerAndLogin(`${nameA}@test.dev`, nameA)
    const b = await registerAndLogin(`${nameB}@test.dev`, nameB)
    return { a, b, nameB }
  }

  const blockOf = (blocker: TestUser, target: TestUser, reason?: string) =>
    req(blocker.jar, 'POST', '/api/blocks', { userId: target.userId, reason })

  it('creates, lists, repeats idempotently, and removes only the caller\'s own block', async () => {
    const { a, b } = await pair()

    expect((await blockOf(a, a)).status).toBe(400)
    expect((await req(a.jar, 'POST', '/api/blocks', { userId: 'no-such-user-id' })).status).toBe(404)

    const first = await blockOf(a, b, 'spam')
    expect(first.status).toBe(201)
    expect(first.data.block.user.id).toBe(b.userId)
    expect(JSON.stringify(first.data)).not.toContain('@test.dev')

    const again = await blockOf(a, b)
    expect(again.status).toBe(200)
    expect(await testPrisma.block.count({ where: { blockerId: a.userId, blockedId: b.userId } })).toBe(1)

    const mine = await req(a.jar, 'GET', '/api/blocks')
    expect(mine.data.blocks.map((x: any) => x.user.id)).toEqual([b.userId])

    // The blocked user cannot see that they were blocked, and cannot lift it.
    const theirs = await req(b.jar, 'GET', '/api/blocks')
    expect(theirs.data.blocks).toEqual([])
    const lift = await req(b.jar, 'DELETE', `/api/blocks/${a.userId}`)
    expect(lift.status).toBe(200)
    expect(lift.data.unblocked).toBe(false)
    expect(await testPrisma.block.count({ where: { blockerId: a.userId, blockedId: b.userId } })).toBe(1)

    const unblock = await req(a.jar, 'DELETE', `/api/blocks/${b.userId}`)
    expect(unblock.data.unblocked).toBe(true)
    const unblockAgain = await req(a.jar, 'DELETE', `/api/blocks/${b.userId}`)
    expect(unblockAgain.status).toBe(200)
    expect(unblockAgain.data.unblocked).toBe(false)
    expect((await req(a.jar, 'DELETE', '/api/blocks/garbage-id')).status).toBe(200)
  })

  it('severs an accepted connection and a pending request when a block is placed', async () => {
    const { a, b } = await pair()
    const { a: c } = await pair()

    const connection = await req(a.jar, 'POST', '/api/connections', { receiverId: b.userId, type: 'NETWORK' })
    await req(b.jar, 'PATCH', `/api/connections/${connection.data.id}`, { status: 'ACCEPTED' })
    await req(c.jar, 'POST', '/api/connections', { receiverId: b.userId, type: 'FRIEND' })

    const result = await blockOf(b, a)
    expect(result.data.severedConnections).toBe(1)
    expect(await testPrisma.connection.count({ where: { OR: [{ senderId: a.userId }, { receiverId: a.userId }] } })).toBe(0)

    // c's pending request to b survives a block on someone else, then is severed by b blocking c.
    expect(await testPrisma.connection.count({ where: { senderId: c.userId, receiverId: b.userId } })).toBe(1)
    await blockOf(b, c)
    expect(await testPrisma.connection.count({ where: { senderId: c.userId, receiverId: b.userId } })).toBe(0)
  })

  it('withdraws pending applications and invitations between the pair', async () => {
    const { a: owner, b: applicant } = await pair()
    const { b: invitee } = await pair()

    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Blk Team ${nextName('t')}` })
    const application = await req(applicant.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
    const invitation = await req(owner.jar, 'POST', `/api/teams/${team.data.id}/invitations`, { userId: invitee.userId })
    expect(application.status).toBe(201)
    expect(invitation.status).toBe(201)

    const first = await blockOf(owner, applicant)
    expect(first.data.withdrawnApplications).toBe(1)
    const second = await blockOf(invitee, owner)
    expect(second.data.withdrawnApplications).toBe(1)

    const statuses = await testPrisma.teamApplication.findMany({
      where: { id: { in: [application.data.id, invitation.data.id] } },
      select: { id: true, status: true },
    })
    expect(statuses.every((s) => s.status === 'WITHDRAWN')).toBe(true)
  })

  it('refuses connection requests in both directions and allows them again after unblocking', async () => {
    const { a, b } = await pair()
    await blockOf(a, b)

    const fromBlocker = await req(a.jar, 'POST', '/api/connections', { receiverId: b.userId, type: 'NETWORK' })
    expect(fromBlocker.status).toBe(403)
    const fromBlocked = await req(b.jar, 'POST', '/api/connections', { receiverId: a.userId, type: 'NETWORK' })
    expect(fromBlocked.status).toBe(404)
    expect(fromBlocked.data.error).toBe('User not found')

    await req(a.jar, 'DELETE', `/api/blocks/${b.userId}`)
    const after = await req(b.jar, 'POST', '/api/connections', { receiverId: a.userId, type: 'NETWORK' })
    expect(after.status).toBe(201)
  })

  it('refuses to accept a connection that predates a block (backstop)', async () => {
    const { a, b } = await pair()
    const connection = await testPrisma.connection.create({ data: { senderId: a.userId, receiverId: b.userId } })
    // Bypass the endpoint so the pending row survives, as if it predated the block.
    await testPrisma.block.create({ data: { blockerId: b.userId, blockedId: a.userId } })

    const accept = await req(b.jar, 'PATCH', `/api/connections/${connection.id}`, { status: 'ACCEPTED' })
    expect(accept.status).toBe(403)
    expect((await testPrisma.connection.findUnique({ where: { id: connection.id } }))?.status).toBe('PENDING')
  })

  it('refuses team invitations in both directions', async () => {
    const { a: owner, b: other } = await pair()
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Blk Invite ${nextName('t')}` })

    await blockOf(owner, other)
    const asBlocker = await req(owner.jar, 'POST', `/api/teams/${team.data.id}/invitations`, { userId: other.userId })
    expect(asBlocker.status).toBe(403)
    await req(owner.jar, 'DELETE', `/api/blocks/${other.userId}`)

    await blockOf(other, owner)
    const asBlocked = await req(owner.jar, 'POST', `/api/teams/${team.data.id}/invitations`, { userId: other.userId })
    expect(asBlocked.status).toBe(404)
  })

  it('refuses team applications in both directions and blocks accepting one that predates the block', async () => {
    const { a: owner, b: applicant } = await pair()
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Blk Apply ${nextName('t')}` })
    const teamId = team.data.id

    await blockOf(owner, applicant)
    const blockedApplicant = await req(applicant.jar, 'POST', `/api/teams/${teamId}/applications`, {})
    expect(blockedApplicant.status).toBe(404)
    expect(blockedApplicant.data.error).toBe('Team not found')
    await req(owner.jar, 'DELETE', `/api/blocks/${applicant.userId}`)

    await blockOf(applicant, owner)
    const blockerApplicant = await req(applicant.jar, 'POST', `/api/teams/${teamId}/applications`, {})
    expect(blockerApplicant.status).toBe(403)
    await req(applicant.jar, 'DELETE', `/api/blocks/${owner.userId}`)

    // An application that already exists when a block appears cannot be accepted.
    const application = await req(applicant.jar, 'POST', `/api/teams/${teamId}/applications`, {})
    expect(application.status).toBe(201)
    await testPrisma.block.create({ data: { blockerId: owner.userId, blockedId: applicant.userId } })
    const accept = await req(owner.jar, 'PATCH', `/api/teams/${teamId}/applications/${application.data.id}`, { status: 'ACCEPTED' })
    expect(accept.status).toBe(403)
    expect(await testPrisma.teamMember.count({ where: { teamId, userId: applicant.userId } })).toBe(0)
  })

  it('refuses new direct conversations and messages in a direct conversation, both ways, but not shared team rooms', async () => {
    const { a, b } = await pair()

    const connection = await req(a.jar, 'POST', '/api/connections', { receiverId: b.userId, type: 'NETWORK' })
    await req(b.jar, 'PATCH', `/api/connections/${connection.data.id}`, { status: 'ACCEPTED' })
    const conversations = await req(a.jar, 'GET', '/api/conversations')
    const list = conversations.data.conversations ?? conversations.data
    const dm = list.find((c: any) => c.type === 'DIRECT')
    expect(dm).toBeTruthy()
    expect((await req(b.jar, 'POST', `/api/conversations/${dm.id}`, { content: 'hi' })).status).toBe(201)

    // A shared team room the same two users are in.
    const team = await req(a.jar, 'POST', '/api/teams', { name: `Blk Room ${nextName('t')}` })
    const application = await req(b.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
    await req(a.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${application.data.id}`, { status: 'ACCEPTED' })
    const teamConversation = await testPrisma.conversation.findUnique({ where: { teamId: team.data.id } })

    await blockOf(a, b)

    const blockerSends = await req(a.jar, 'POST', `/api/conversations/${dm.id}`, { content: 'hello?' })
    expect(blockerSends.status).toBe(403)
    const blockedSends = await req(b.jar, 'POST', `/api/conversations/${dm.id}`, { content: 'hello?' })
    expect(blockedSends.status).toBe(404)
    expect(blockedSends.data.error).toBe('Conversation not found')
    expect(await testPrisma.message.count({ where: { conversationId: dm.id } })).toBe(1)

    expect((await req(a.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [b.userId] })).status).toBe(403)
    expect((await req(b.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [a.userId] })).status).toBe(404)
    const group = await req(b.jar, 'POST', '/api/conversations', { type: 'GROUP', name: 'x', participantIds: [a.userId] })
    expect(group.status).toBe(404)

    // The shared team room is not addressed to one person and stays open.
    expect((await req(b.jar, 'POST', `/api/conversations/${teamConversation!.id}`, { content: 'still a teammate' })).status).toBe(201)
  })

  it('hides each user from the other in discover and user search', async () => {
    const { a, b, nameB } = await pair()
    const nameA = (await testPrisma.user.findUnique({ where: { id: a.userId } }))!.username!

    const seesBefore = await req(a.jar, 'GET', `/api/discover?search=${nameB}`)
    expect(seesBefore.data.people.map((p: any) => p.id)).toContain(b.userId)
    const searchBefore = await req(a.jar, 'GET', `/api/users?search=${nameB}`)
    expect(searchBefore.data.users.map((u: any) => u.id)).toContain(b.userId)

    await blockOf(a, b)

    for (const [viewer, hiddenName, hiddenId] of [
      [a, nameB, b.userId],
      [b, nameA, a.userId],
    ] as const) {
      const discover = await req(viewer.jar, 'GET', `/api/discover?search=${hiddenName}`)
      expect(discover.data.people.map((p: any) => p.id)).not.toContain(hiddenId)
      const search = await req(viewer.jar, 'GET', `/api/users?search=${hiddenName}`)
      expect(search.data.users.map((u: any) => u.id)).not.toContain(hiddenId)
    }
  })

  it('hides each user from the other in team candidates', async () => {
    const { a: owner, b: candidate } = await pair()
    const skill = await testPrisma.skill.create({
      data: { name: `Blk Skill ${suffix}${n++}`, slug: `blk-skill-${suffix}-${n}`, category: 'Test' },
    })
    await testPrisma.userSkill.create({ data: { userId: candidate.userId, skillId: skill.id, level: 4 } })
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Blk Cand ${nextName('t')}`, lookingFor: [skill.name] })

    const before = await req(owner.jar, 'GET', `/api/teams/${team.data.id}/candidates`)
    expect(before.data.candidates.map((c: any) => c.id)).toContain(candidate.userId)

    // Block placed by the candidate (the blocked-by-them direction from the owner's view).
    await blockOf(candidate, owner)
    const afterCandidateBlocks = await req(owner.jar, 'GET', `/api/teams/${team.data.id}/candidates`)
    expect(afterCandidateBlocks.data.candidates.map((c: any) => c.id)).not.toContain(candidate.userId)

    await req(candidate.jar, 'DELETE', `/api/blocks/${owner.userId}`)
    await blockOf(owner, candidate)
    const afterOwnerBlocks = await req(owner.jar, 'GET', `/api/teams/${team.data.id}/candidates`)
    expect(afterOwnerBlocks.data.candidates.map((c: any) => c.id)).not.toContain(candidate.userId)
  })

  it('hides each user from the other on the leaderboard and ranks among visible users', async () => {
    const { a, b } = await pair()
    await req(a.jar, 'POST', '/api/projects', { name: `Blk Lb ${nextName('p')}` })
    await req(b.jar, 'POST', '/api/projects', { name: `Blk Lb ${nextName('p')}` })

    const before = await req(a.jar, 'GET', '/api/leaderboard?limit=100')
    const idsBefore = before.data.entries.map((e: any) => e.user.id)
    expect(idsBefore).toContain(b.userId)
    expect(idsBefore).toContain(a.userId)

    await blockOf(a, b)

    const asBlocker = await req(a.jar, 'GET', '/api/leaderboard?limit=100')
    expect(asBlocker.data.entries.map((e: any) => e.user.id)).not.toContain(b.userId)
    expect(asBlocker.data.pagination.total).toBeLessThan(before.data.pagination.total)
    const asBlocked = await req(b.jar, 'GET', '/api/leaderboard?limit=100')
    expect(asBlocked.data.entries.map((e: any) => e.user.id)).not.toContain(a.userId)
    // Ranks are consecutive over what the viewer can see.
    const ranks = asBlocker.data.entries.map((e: any) => e.rank)
    expect(ranks).toEqual(ranks.map((_: number, i: number) => i + 1))
  })

  it('makes a blocker\'s profile look nonexistent to the blocked user, and flags blockedByMe to the blocker', async () => {
    const { a, b } = await pair()
    await blockOf(a, b)

    const blockedViewsBlocker = await req(b.jar, 'GET', `/api/users/${a.userId}`)
    expect(blockedViewsBlocker.status).toBe(404)
    const blockerViewsBlocked = await req(a.jar, 'GET', `/api/users/${b.userId}`)
    expect(blockerViewsBlocked.status).toBe(200)
    expect(blockerViewsBlocked.data.blockedByMe).toBe(true)

    await req(a.jar, 'DELETE', `/api/blocks/${b.userId}`)
    expect((await req(b.jar, 'GET', `/api/users/${a.userId}`)).status).toBe(200)
  })
})
