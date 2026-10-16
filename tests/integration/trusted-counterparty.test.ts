import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, establishAccount, testPrisma } from './db'

// Rewards that another person triggers pay only when that person is a trusted counterparty (src/lib/trust.ts): an
// account at least seven days old, with a verified email, that has not blocked you and you have not blocked. One
// path at a time, through the real routes: what the person who did NOT act is paid, counted and unlocked.
describe('trusted counterparty', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let skillId: string

  afterAll(async () => {
    await cleanupTestUsers(suffix)
    await testPrisma.skill.deleteMany({ where: { slug: `tc-skill-${suffix}` } })
  })

  /** A signed-in account, established unless a test asks for something else. */
  async function user(label: string, trust: 'trusted' | 'new' | 'unverified' = 'trusted'): Promise<TestUser> {
    const name = `tc${label}${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    if (trust === 'new') await establishAccount(u.userId, { ageDays: 2, verified: true })
    if (trust === 'unverified') await establishAccount(u.userId, { ageDays: 60, verified: false })
    return u
  }
  const BAD = ['new', 'unverified'] as const

  const xp = async (userId: string, type: string) => (await testPrisma.xPEvent.findMany({ where: { userId, type } })).reduce((sum, row) => sum + row.amount, 0)
  const counter = async (userId: string, key: string) => (await testPrisma.userCounter.findUnique({ where: { userId_key: { userId, key } } }))?.value ?? 0
  const achievement = (userId: string, slug: string) => testPrisma.userAchievement.count({ where: { userId, achievement: { slug } } })
  const verifyLogin = (u: TestUser) => testPrisma.user.update({ where: { id: u.userId }, data: { verificationLevel: 'EMAIL' } })

  // --- endorsements ----------------------------------------------------------------------------------

  async function evidenceFor(owner: TestUser): Promise<string> {
    skillId ??= (await testPrisma.skill.create({ data: { name: `Tc Skill ${suffix}`, slug: `tc-skill-${suffix}`, category: 'Test' } })).id
    await testPrisma.userSkill.upsert({ where: { userId_skillId: { userId: owner.userId, skillId } }, update: {}, create: { userId: owner.userId, skillId } })
    const res = await req(owner.jar, 'POST', '/api/evidence', { skillId, type: 'PORTFOLIO', title: `Work ${n++}`, url: 'https://example.com/x' })
    expect(res.status).toBe(201)
    return res.data.id
  }

  describe('endorsements', () => {
    it('pay the owner, count it for both, and unlock the achievement, when the endorser is trusted', async () => {
      const owner = await user('eo', 'new') // the owner's own account does not matter
      const endorser = await user('ee')
      await verifyLogin(endorser)
      const evidence = await evidenceFor(owner)
      expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(201)
      expect(await xp(owner.userId, 'EVIDENCE_ENDORSED')).toBe(10)
      expect(await counter(owner.userId, 'endorsements_received')).toBe(1)
      expect(await counter(endorser.userId, 'endorsements_given')).toBe(1)
      expect(await achievement(owner.userId, 'endorsed')).toBe(1)
    })

    for (const trust of BAD) {
      it(`pay nothing, count nothing and unlock nothing when the endorser's account is ${trust}`, async () => {
        const owner = await user('eo')
        const endorser = await user('ee', trust)
        await verifyLogin(endorser) // the endorser's verified login is not what is being tested
        const evidence = await evidenceFor(owner)
        // The endorsement itself still goes through and counts toward the evidence.
        expect((await req(endorser.jar, 'POST', `/api/evidence/${evidence}/endorse`)).status).toBe(201)
        expect(await xp(owner.userId, 'EVIDENCE_ENDORSED')).toBe(0)
        expect(await counter(owner.userId, 'endorsements_received')).toBe(0)
        expect(await counter(endorser.userId, 'endorsements_given')).toBe(0)
        expect(await achievement(owner.userId, 'endorsed')).toBe(0)
      })
    }
  })

  // --- accepted team applications and invitations ---------------------------------------------------------

  describe('team applications', () => {
    const apply = async (lead: TestUser, applicant: TestUser) => {
      const team = await req(lead.jar, 'POST', '/api/teams', { name: `Tc Team ${suffix}${n++}` })
      expect(team.status).toBe(201)
      const application = await req(applicant.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
      expect(application.status).toBe(201)
      return { teamId: team.data.id as string, applicationId: application.data.id as string }
    }
    const accept = async (lead: TestUser, teamId: string, applicationId: string) =>
      expect((await req(lead.jar, 'PATCH', `/api/teams/${teamId}/applications/${applicationId}`, { status: 'ACCEPTED' })).status).toBe(200)

    it('pay the applicant when the reviewer who accepted them is trusted', async () => {
      const lead = await user('al')
      const applicant = await user('aa')
      const { teamId, applicationId } = await apply(lead, applicant)
      await accept(lead, teamId, applicationId)
      expect(await xp(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toBe(50)
      expect(await counter(applicant.userId, 'teams_joined')).toBe(1)
      expect(await achievement(applicant.userId, 'team-player')).toBe(1)
    })

    for (const trust of BAD) {
      it(`pay the applicant nothing when the reviewer's account is ${trust}, but they are still on the team`, async () => {
        const lead = await user('al', trust)
        const applicant = await user('aa')
        const { teamId, applicationId } = await apply(lead, applicant)
        await accept(lead, teamId, applicationId)
        expect(await xp(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toBe(0)
        expect(await counter(applicant.userId, 'teams_joined')).toBe(0)
        expect(await achievement(applicant.userId, 'team-player')).toBe(0)
        expect(await testPrisma.teamMember.count({ where: { userId: applicant.userId, teamId } })).toBe(1)
      })

      it(`pay the applicant nothing when their own account is ${trust}`, async () => {
        const lead = await user('al')
        const applicant = await user('aa', trust)
        const { teamId, applicationId } = await apply(lead, applicant)
        await accept(lead, teamId, applicationId)
        expect(await xp(applicant.userId, 'TEAM_APPLICATION_ACCEPTED')).toBe(0)
        expect(await achievement(applicant.userId, 'team-player')).toBe(0)
      })
    }

    it('judge an accepted invitation by the person who sent it, not by the invitee who accepted', async () => {
      const trustedInviter = await user('il')
      const newInviter = await user('in', 'new')
      const invitee = await user('ii')
      for (const [inviter, expected] of [[trustedInviter, 50], [newInviter, 0]] as const) {
        const team = await req(inviter.jar, 'POST', '/api/teams', { name: `Tc Invite ${suffix}${n++}` })
        const invitation = await testPrisma.teamApplication.create({ data: { teamId: team.data.id, userId: invitee.userId, invitedById: inviter.userId, status: 'PENDING' } })
        const before = await xp(invitee.userId, 'TEAM_APPLICATION_ACCEPTED')
        const accepted = await req(invitee.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${invitation.id}`, { status: 'ACCEPTED' })
        expect(accepted.status).toBe(200)
        expect((await xp(invitee.userId, 'TEAM_APPLICATION_ACCEPTED')) - before).toBe(expected)
      }
    })
  })

  // --- connections -----------------------------------------------------------------------------------------

  describe('connections', () => {
    const connect = async (sender: TestUser, receiver: TestUser) => {
      const connection = await testPrisma.connection.create({ data: { senderId: sender.userId, receiverId: receiver.userId, status: 'PENDING' } })
      const accepted = await req(receiver.jar, 'PATCH', `/api/connections/${connection.id}`, { status: 'ACCEPTED' })
      expect(accepted.status).toBe(200)
    }

    it('pay both people when each is trusted by the other', async () => {
      const [sender, receiver] = [await user('cs'), await user('cr')]
      await connect(sender, receiver)
      for (const person of [sender, receiver]) {
        expect(await xp(person.userId, 'CONNECTION_ACCEPTED')).toBe(10)
        expect(await counter(person.userId, 'connections')).toBe(1)
      }
    })

    for (const trust of BAD) {
      it(`pay only the person whose counterparty is trusted when the sender's account is ${trust}`, async () => {
        const sender = await user('cs', trust)
        const receiver = await user('cr')
        await connect(sender, receiver)
        // The receiver accepted a request from an untrusted account: nothing for them. The sender was connected to a trusted one.
        expect(await xp(receiver.userId, 'CONNECTION_ACCEPTED')).toBe(0)
        expect(await counter(receiver.userId, 'connections')).toBe(0)
        expect(await xp(sender.userId, 'CONNECTION_ACCEPTED')).toBe(10)
        expect(await counter(sender.userId, 'connections')).toBe(1)
      })
    }

    it('pay neither when neither account is trusted', async () => {
      const [sender, receiver] = [await user('cs', 'new'), await user('cr', 'unverified')]
      await connect(sender, receiver)
      for (const person of [sender, receiver]) {
        expect(await xp(person.userId, 'CONNECTION_ACCEPTED')).toBe(0)
        expect(await counter(person.userId, 'connections')).toBe(0)
      }
    })
  })

  // --- first messages and replies -------------------------------------------------------------------------

  describe('messages', () => {
    async function direct(a: TestUser, b: TestUser) {
      await testPrisma.connection.create({ data: { senderId: a.userId, receiverId: b.userId, status: 'ACCEPTED' } })
      return testPrisma.conversation.create({
        data: { type: 'DIRECT', members: { create: [{ userId: a.userId, role: 'OWNER' }, { userId: b.userId, role: 'MEMBER' }] } },
      })
    }

    it('pay the sender of a first message when the recipient is trusted', async () => {
      const [sender, recipient] = [await user('ms', 'new'), await user('mr')]
      const conversation = await direct(sender, recipient)
      expect((await req(sender.jar, 'POST', `/api/conversations/${conversation.id}`, { content: 'Hello' })).status).toBe(201)
      expect(await xp(sender.userId, 'MESSAGE_SENT_FIRST_IN_CONNECTION')).toBe(5)
      expect(await counter(sender.userId, 'first_messages')).toBe(1)
    })

    for (const trust of BAD) {
      it(`pay the sender nothing when the recipient's account is ${trust}`, async () => {
        const [sender, recipient] = [await user('ms'), await user('mr', trust)]
        const conversation = await direct(sender, recipient)
        expect((await req(sender.jar, 'POST', `/api/conversations/${conversation.id}`, { content: 'Hello' })).status).toBe(201)
        expect(await xp(sender.userId, 'MESSAGE_SENT_FIRST_IN_CONNECTION')).toBe(0)
        expect(await counter(sender.userId, 'first_messages')).toBe(0)
      })
    }

    // A reply pays no XP; it counts toward the replies metric (and so the achievements and quests that ask for replies).
    async function waitingOn(waiting: TestUser, replier: TestUser) {
      const conversation = await direct(waiting, replier)
      await testPrisma.message.create({ data: { conversationId: conversation.id, senderId: waiting.userId, content: 'Are you there?' } })
      return conversation
    }

    it('count a reply to a trusted person who was waiting', async () => {
      const [waiting, replier] = [await user('rw'), await user('rr', 'new')]
      const conversation = await waitingOn(waiting, replier)
      expect((await req(replier.jar, 'POST', `/api/conversations/${conversation.id}`, { content: 'Here!' })).status).toBe(201)
      expect(await counter(replier.userId, 'replies')).toBe(1)
    })

    for (const trust of BAD) {
      it(`count nothing for a reply to somebody whose account is ${trust}`, async () => {
        const [waiting, replier] = [await user('rw', trust), await user('rr')]
        const conversation = await waitingOn(waiting, replier)
        expect((await req(replier.jar, 'POST', `/api/conversations/${conversation.id}`, { content: 'Here!' })).status).toBe(201)
        expect(await counter(replier.userId, 'replies')).toBe(0)
      })
    }

    it('count a reply again only for a trusted person: two throwaway accounts answering each other earn nothing', async () => {
      const [a, b] = [await user('ra', 'new'), await user('rb', 'new')]
      const conversation = await waitingOn(a, b)
      for (let round = 0; round < 3; round++) {
        await req(b.jar, 'POST', `/api/conversations/${conversation.id}`, { content: `pong ${round}` })
        await req(a.jar, 'POST', `/api/conversations/${conversation.id}`, { content: `ping ${round}` })
      }
      expect(await counter(a.userId, 'replies')).toBe(0)
      expect(await counter(b.userId, 'replies')).toBe(0)
    })
  })

  // --- blocks ----------------------------------------------------------------------------------------------

  describe('blocks', () => {
    it('pay nothing for a reward that the routes allowed before the block and the gate sees after it', async () => {
      // The routes refuse most interactions across a block, so the gate is the second line: a connection accepted a moment
      // before a block does not pay, because by the time the reward is decided the block exists.
      const [sender, receiver] = [await user('bs'), await user('br')]
      const connection = await testPrisma.connection.create({ data: { senderId: sender.userId, receiverId: receiver.userId, status: 'PENDING' } })
      await testPrisma.block.create({ data: { blockerId: sender.userId, blockedId: receiver.userId } })
      await req(receiver.jar, 'PATCH', `/api/connections/${connection.id}`, { status: 'ACCEPTED' })
      for (const person of [sender, receiver]) expect(await xp(person.userId, 'CONNECTION_ACCEPTED')).toBe(0)
    })
  })
})
