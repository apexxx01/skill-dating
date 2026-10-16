import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'

// The XP that progress and community actions pay, through the real routes and the
// real database: the amount, the daily cap, and what cannot be paid twice. The
// rules themselves are in src/lib/rewards-config.ts.
describe('XP for progress and community actions', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let skillId: string | undefined

  afterAll(async () => {
    await cleanupTestUsers(suffix)
    await testPrisma.skill.deleteMany({ where: { slug: `xa-skill-${suffix}` } })
  })

  const user = async (label: string): Promise<TestUser> => {
    const name = `xa${label}${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  // A user with no sign-in: for the other side of an interaction the test does not drive.
  const ghost = (label: string) => {
    const name = `xag${label}${suffix}${n++}`
    // An account other people's rewards can rest on: a week old, verified (see src/lib/trust.ts).
    return testPrisma.user.create({ data: { email: `${name}@test.dev`, username: name, name, createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), isEmailVerified: true } })
  }

  const rows = (userId: string, type: string) => testPrisma.xPEvent.findMany({ where: { userId, type }, orderBy: { createdAt: 'asc' } })
  const total = async (userId: string, type: string) => (await rows(userId, type)).reduce((sum, row) => sum + row.amount, 0)
  const xpOf = async (userId: string) => (await testPrisma.user.findUniqueOrThrow({ where: { id: userId } })).xp

  const project = async (u: TestUser) => (await req(u.jar, 'POST', '/api/projects', { name: `Xa ${suffix}${n++}` })).data.id as string

  async function skill() {
    skillId ??= (await testPrisma.skill.create({ data: { name: `Xa Skill ${suffix}`, slug: `xa-skill-${suffix}`, category: 'Test' } })).id
    return skillId
  }

  async function holdSkill(u: TestUser) {
    const id = await skill()
    await testPrisma.userSkill.upsert({
      where: { userId_skillId: { userId: u.userId, skillId: id } },
      update: {},
      create: { userId: u.userId, skillId: id },
    })
    return id
  }

  const addEvidence = async (u: TestUser, title: string) => {
    const res = await req(u.jar, 'POST', '/api/evidence', { skillId: await holdSkill(u), type: 'PORTFOLIO', title, url: 'https://example.com/x' })
    expect(res.status).toBe(201)
    return res
  }

  it('MILESTONE_COMPLETED: 30 XP per milestone, once each, 5 a day', async () => {
    const u = await user('ms')
    const projectId = await project(u)
    const ids: string[] = []
    for (let index = 0; index < 7; index++) {
      const created = await req(u.jar, 'POST', `/api/projects/${projectId}/milestones`, { title: `Step ${index}` })
      expect(created.status).toBe(201)
      ids.push(created.data.id)
    }
    const complete = (id: string, completed = true) => req(u.jar, 'PATCH', `/api/projects/${projectId}/milestones/${id}`, { completed })

    const first = await complete(ids[0])
    expect(first.data.rewards.xpGained).toBe(30 + 50) // the milestone and the First Milestone achievement
    const gains: number[] = []
    for (const id of ids.slice(1)) gains.push((await complete(id)).data.rewards.xpGained)
    expect(gains).toEqual([30, 30, 30, 30, 0, 0])

    expect(await rows(u.userId, 'MILESTONE_COMPLETED')).toHaveLength(5)
    expect(await total(u.userId, 'MILESTONE_COMPLETED')).toBe(150)

    // Reopening and completing again pays nothing more, whether or not the cap is reached.
    await complete(ids[0], false)
    expect((await complete(ids[0])).data.rewards.xpGained).toBe(0)
    expect(await rows(u.userId, 'MILESTONE_COMPLETED')).toHaveLength(5)
    expect((await rows(u.userId, 'MILESTONE_COMPLETED'))[0]).toMatchObject({ sourceType: 'MILESTONE', sourceId: ids[0], dedupeKey: `milestone:${ids[0]}` })

    // The update post a completed milestone creates by itself is not an update the user posted.
    expect(await rows(u.userId, 'PROJECT_UPDATE_POSTED')).toHaveLength(0)
    expect(await xpOf(u.userId)).toBe((await testPrisma.xPEvent.aggregate({ where: { userId: u.userId }, _sum: { amount: true } }))._sum.amount)
  })

  it('PROJECT_UPDATE_POSTED: 15 XP per update, 3 a day', async () => {
    const u = await user('up')
    const projectId = await project(u)
    const gains: number[] = []
    for (let index = 0; index < 5; index++) {
      const res = await req(u.jar, 'POST', `/api/projects/${projectId}/updates`, { title: `Week ${index}`, content: 'Made progress.' })
      expect(res.status).toBe(201)
      gains.push(res.data.rewards.xpGained)
    }
    expect(gains).toEqual([15 + 25, 15, 15, 0, 0]) // the first also unlocks Building in Public
    expect(await rows(u.userId, 'PROJECT_UPDATE_POSTED')).toHaveLength(3)
    expect(await total(u.userId, 'PROJECT_UPDATE_POSTED')).toBe(45)
  })

  it('EVIDENCE_ADDED: 20 XP per piece of evidence, 3 a day', async () => {
    const u = await user('ev')
    const gains: number[] = []
    const ids: string[] = []
    for (let index = 0; index < 5; index++) {
      const res = await addEvidence(u, `Work ${index}`)
      gains.push(res.data.rewards.xpGained)
      ids.push(res.data.id)
    }
    expect(gains).toEqual([20 + 25, 20, 20, 0, 0]) // the first also unlocks Show Your Work
    const paid = await rows(u.userId, 'EVIDENCE_ADDED')
    expect(paid.map((row) => row.sourceId)).toEqual(ids.slice(0, 3))
    expect(paid[0]).toMatchObject({ amount: 20, sourceType: 'EVIDENCE', dedupeKey: `evidence:${ids[0]}` })

    // Deleting paid evidence does not free the cap, and the award stays.
    expect((await req(u.jar, 'DELETE', `/api/evidence/${ids[0]}`)).status).toBe(200)
    expect((await addEvidence(u, 'Replacement')).data.rewards.xpGained).toBe(0)
    expect(await rows(u.userId, 'EVIDENCE_ADDED')).toHaveLength(3)
  })

  describe('EVIDENCE_ENDORSED', () => {
    it('pays the owner 10 XP per endorsement, once per endorser and evidence, 10 a day', async () => {
      const owner = await user('eo')
      const [first, second] = [await user('e1'), await user('e2')]
      const evidence: string[] = []
      for (let index = 0; index < 12; index++) evidence.push((await addEvidence(owner, `Piece ${index}`)).data.id)
      const endorse = (who: TestUser, id: string) => req(who.jar, 'POST', `/api/evidence/${id}/endorse`)

      expect((await endorse(first, evidence[0])).status).toBe(201)
      expect(await rows(owner.userId, 'EVIDENCE_ENDORSED')).toHaveLength(1)

      // Withdrawing and endorsing again is the same endorsement: no second payment.
      await req(first.jar, 'DELETE', `/api/evidence/${evidence[0]}/endorse`)
      expect((await endorse(first, evidence[0])).status).toBe(201)
      expect(await rows(owner.userId, 'EVIDENCE_ENDORSED')).toHaveLength(1)
      expect((await rows(owner.userId, 'EVIDENCE_ENDORSED'))[0]).toMatchObject({
        amount: 10,
        sourceType: 'ENDORSEMENT',
        sourceId: `${evidence[0]}:${first.userId}`,
      })

      // Two endorsers, twelve endorsements: the owner is paid for ten.
      for (const id of evidence.slice(1, 6)) expect((await endorse(first, id)).status).toBe(201)
      for (const id of evidence.slice(6)) expect((await endorse(second, id)).status).toBe(201)
      expect(await rows(owner.userId, 'EVIDENCE_ENDORSED')).toHaveLength(10)
      expect(await total(owner.userId, 'EVIDENCE_ENDORSED')).toBe(100)
      // Every endorsement still counted toward the evidence.
      expect(await testPrisma.skillEvidence.count({ where: { type: 'PEER_ENDORSEMENT', userId: owner.userId } })).toBe(12)
    })

    it('pays nothing for endorsing yourself, across a block, or from an unverified account', async () => {
      const owner = await user('no')
      const endorser = await user('ne')
      const evidence = (await addEvidence(owner, 'Mine')).data.id
      const paid = () => rows(owner.userId, 'EVIDENCE_ENDORSED')

      expect((await req(owner.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBeGreaterThanOrEqual(400)
      expect(await paid()).toHaveLength(0)

      await req(owner.jar, 'POST', '/api/blocks', { userId: endorser.userId })
      expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(404)
      await req(owner.jar, 'DELETE', `/api/blocks/${endorser.userId}`)
      await req(endorser.jar, 'POST', '/api/blocks', { userId: owner.userId })
      expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(403)
      await req(endorser.jar, 'DELETE', `/api/blocks/${owner.userId}`)
      expect(await paid()).toHaveLength(0)

      await testPrisma.user.update({ where: { id: endorser.userId }, data: { verificationLevel: 'NONE', isEmailVerified: false } })
      expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(201)
      expect(await paid()).toHaveLength(0)
    })
  })

  it('CONNECTION_ACCEPTED: 10 XP to both people, once per connection, 5 a day each', async () => {
    const receiver = await user('cr')
    const senders = []
    for (let index = 0; index < 6; index++) {
      const sender = await ghost('cs')
      const connection = await testPrisma.connection.create({ data: { senderId: sender.id, receiverId: receiver.userId, status: 'PENDING' } })
      senders.push({ sender, connection })
    }
    const gains: number[] = []
    for (const { connection } of senders) {
      const accepted = await req(receiver.jar, 'PATCH', `/api/connections/${connection.id}`, { status: 'ACCEPTED' })
      expect(accepted.status).toBe(200)
      // The accepted connection is still the body; the accepter's own rewards ride along.
      expect(accepted.data).toMatchObject({ id: connection.id, status: 'ACCEPTED' })
      gains.push(accepted.data.rewards.xpGained)
    }
    expect(gains).toEqual([10, 10, 10, 10, 10, 0])

    // The accepter hit the cap on the sixth; every sender was paid for their one.
    const paid = await rows(receiver.userId, 'CONNECTION_ACCEPTED')
    expect(paid).toHaveLength(5)
    expect(paid[0]).toMatchObject({ amount: 10, sourceType: 'CONNECTION', sourceId: senders[0].connection.id, dedupeKey: `connection:${senders[0].connection.id}` })
    for (const { sender, connection } of senders) {
      const theirs = await rows(sender.id, 'CONNECTION_ACCEPTED')
      expect(theirs).toHaveLength(1)
      expect(theirs[0]).toMatchObject({ amount: 10, sourceId: connection.id })
      expect(await xpOf(sender.id)).toBe(10)
    }

    // Accepting again is refused, and pays nobody.
    const again = await req(receiver.jar, 'PATCH', `/api/connections/${senders[0].connection.id}`, { status: 'ACCEPTED' })
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect(await rows(receiver.userId, 'CONNECTION_ACCEPTED')).toHaveLength(5)
    expect(await rows(senders[0].sender.id, 'CONNECTION_ACCEPTED')).toHaveLength(1)
  })

  it('CONNECTION_ACCEPTED: declining pays nothing', async () => {
    const receiver = await user('dr')
    const sender = await ghost('ds')
    const connection = await testPrisma.connection.create({ data: { senderId: sender.id, receiverId: receiver.userId, status: 'PENDING' } })
    const declined = await req(receiver.jar, 'PATCH', `/api/connections/${connection.id}`, { status: 'DECLINED' })
    expect(declined.status).toBe(200)
    expect(declined.data.rewards).toMatchObject({ xpGained: 0, leveledUp: false, achievements: [] })
    expect(await rows(receiver.userId, 'CONNECTION_ACCEPTED')).toHaveLength(0)
    expect(await rows(sender.id, 'CONNECTION_ACCEPTED')).toHaveLength(0)
  })

  it('MESSAGE_SENT_FIRST_IN_CONNECTION: 5 XP to the sender, once per conversation, 5 a day', async () => {
    const sender = await user('ms')
    const conversations: { id: string; peer: string }[] = []
    for (let index = 0; index < 7; index++) {
      const peer = await ghost('mp')
      await testPrisma.connection.create({ data: { senderId: sender.userId, receiverId: peer.id, status: 'ACCEPTED' } })
      const conversation = await testPrisma.conversation.create({
        data: { type: 'DIRECT', members: { create: [{ userId: sender.userId, role: 'OWNER' }, { userId: peer.id, role: 'MEMBER' }] } },
      })
      conversations.push({ id: conversation.id, peer: peer.id })
    }
    const send = (id: string, content: string) => req(sender.jar, 'POST', `/api/conversations/${id}`, { content })

    const gains: number[] = []
    for (const { id } of conversations) {
      const sent = await send(id, 'Hello!')
      expect(sent.status).toBe(201)
      expect(sent.data).toMatchObject({ conversationId: id, content: 'Hello!' })
      gains.push(sent.data.rewards.xpGained)
    }
    expect(gains).toEqual([5, 5, 5, 5, 5, 0, 0])
    const paid = await rows(sender.userId, 'MESSAGE_SENT_FIRST_IN_CONNECTION')
    expect(paid).toHaveLength(5)
    expect(paid[0]).toMatchObject({ amount: 5, sourceType: 'CONVERSATION', sourceId: conversations[0].id, dedupeKey: `conversation:${conversations[0].id}` })

    // A second message in a conversation is not a first message.
    const followUp = await send(conversations[0].id, 'Following up')
    expect(followUp.status).toBe(201)
    expect(followUp.data.rewards.xpGained).toBe(0)
    expect(await rows(sender.userId, 'MESSAGE_SENT_FIRST_IN_CONNECTION')).toHaveLength(5)
    // Only the sender is paid.
    for (const { peer } of conversations) expect(await rows(peer, 'MESSAGE_SENT_FIRST_IN_CONNECTION')).toHaveLength(0)
  })

  it('MESSAGE_SENT_FIRST_IN_CONNECTION: nothing for a first message to someone you are not connected to', async () => {
    const sender = await user('mn')
    const peer = await ghost('mnp')
    const conversation = await testPrisma.conversation.create({
      data: { type: 'DIRECT', members: { create: [{ userId: sender.userId, role: 'OWNER' }, { userId: peer.id, role: 'MEMBER' }] } },
    })
    expect((await req(sender.jar, 'POST', `/api/conversations/${conversation.id}`, { content: 'Hi' })).status).toBe(201)
    expect(await rows(sender.userId, 'MESSAGE_SENT_FIRST_IN_CONNECTION')).toHaveLength(0)
  })

  // Accepted applications only pay accounts that are at least seven days old and have a verified email.
  const matured = (u: TestUser, over: { ageDays?: number; verified?: boolean } = {}) =>
    testPrisma.user.update({
      where: { id: u.userId },
      data: {
        createdAt: new Date(Date.now() - (over.ageDays ?? 8) * 24 * 60 * 60 * 1000),
        isEmailVerified: over.verified ?? true,
      },
    })

  const acceptApplication = async (lead: TestUser, applicant: TestUser, teamName: string) => {
    const team = await req(lead.jar, 'POST', '/api/teams', { name: `${teamName} ${suffix}${n++}` })
    expect(team.status).toBe(201)
    const application = await req(applicant.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
    expect(application.status).toBe(201)
    const path = `/api/teams/${team.data.id}/applications/${application.data.id}`
    const accepted = await req(lead.jar, 'PATCH', path, { status: 'ACCEPTED' })
    expect(accepted.status).toBe(200)
    return { path, applicationId: application.data.id as string }
  }

  it('TEAM_APPLICATION_ACCEPTED: 50 XP to the applicant for each accepted application, 3 a day', async () => {
    const lead = await user('tl')
    const applicant = await user('ta')
    await matured(applicant)
    const accept = (teamName: string) => acceptApplication(lead, applicant, teamName)

    const first = await accept('Alpha')
    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toEqual([
      expect.objectContaining({ amount: 50, sourceType: 'TEAM_APPLICATION', sourceId: first.applicationId, dedupeKey: `team_application:${first.applicationId}` }),
    ])
    expect(await xpOf(applicant.userId)).toBe(50 + 25) // and the Team Player achievement

    // Reviewing it again is refused and pays nothing.
    expect((await req(lead.jar, 'PATCH', first.path, { status: 'ACCEPTED' })).status).toBeGreaterThanOrEqual(400)
    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(1)

    // A different application is a different award, up to the daily cap of three.
    await accept('Beta')
    await accept('Gamma')
    await accept('Delta')
    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(3)
    expect(await total(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toBe(150)
    // The person who accepted is not paid for it.
    expect(await rows(lead.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(0)
  })

  it('TEAM_APPLICATION_ACCEPTED: an account younger than 7 days is accepted but paid nothing, the achievement included', async () => {
    const lead = await user('yl')
    const applicant = await user('ya')
    await matured(applicant, { ageDays: 6 })
    await acceptApplication(lead, applicant, 'Young')

    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(0)
    expect(await testPrisma.userAchievement.count({ where: { userId: applicant.userId, achievement: { slug: 'team-player' } } })).toBe(0)
    expect(await xpOf(applicant.userId)).toBe(0)
    // They are still on the team.
    expect(await testPrisma.teamMember.count({ where: { userId: applicant.userId } })).toBe(1)
  })

  it('TEAM_APPLICATION_ACCEPTED: an old account whose email is not verified is paid nothing', async () => {
    const lead = await user('ul')
    const applicant = await user('ua')
    await matured(applicant, { ageDays: 60, verified: false })
    await acceptApplication(lead, applicant, 'Unverified')

    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(0)
    expect(await xpOf(applicant.userId)).toBe(0)

    // Once the email is verified the next acceptance pays.
    await matured(applicant, { ageDays: 60, verified: true })
    await acceptApplication(lead, applicant, 'Verified')
    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(1)
  })

  it('TEAM_APPLICATION_ACCEPTED: a rejected application pays nothing', async () => {
    const lead = await user('rl')
    const applicant = await user('ra')
    const team = await req(lead.jar, 'POST', '/api/teams', { name: `Reject ${suffix}${n++}` })
    const application = await req(applicant.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
    const rejected = await req(lead.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${application.data.id}`, { status: 'REJECTED' })
    expect(rejected.status).toBe(200)
    expect(await rows(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toHaveLength(0)
  })
})
