import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

const HOUR = 60 * 60 * 1000

// The solo pool: joining it, the automatic squads two days before the registration deadline (balanced, never two people who blocked each other,
// never an untrusted account), answering a proposed squad, a squad forming or failing, round 2, the hourly sweep settling what nobody answered,
// and the reminders to teamless registrants (once per stage, never to someone who switched them off).
describe('the solo pool and automatic squads', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let admin: TestUser
  let people: TestUser[]
  let fresh: TestUser
  let closed: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`spa${suffix}@test.dev`, `spa${suffix}`)
    await promoteToAdmin(admin.userId)
    people = []
    for (let i = 0; i < 4; i++) people.push(await registerAndLogin(`spp${i}${suffix}@test.dev`, `spp${i}${suffix}`))
    fresh = await registerAndLogin(`spf${suffix}@test.dev`, `spf${suffix}`, undefined, { fresh: true })
    closed = await registerAndLogin(`spc${suffix}@test.dev`, `spc${suffix}`)
  }, 180_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await cleanupTestUsers(suffix)
  }, 120_000)

  const hackathon = async (over: Parameters<typeof makeHackathon>[0] = {}) => {
    const h = await makeHackathon({ registrationDeadline: new Date(Date.now() + 30 * HOUR), startDate: new Date(Date.now() + 3 * 24 * HOUR), endDate: new Date(Date.now() + 4 * 24 * HOUR), minTeamSize: 2, maxTeamSize: 3, ...over })
    hackathons.push(h.id)
    return h
  }
  const job = (name: string, data: Record<string, unknown> = {}) => req(admin.jar, 'POST', `/api/admin/jobs/${name}`, { data })
  const join = (who: TestUser, hackathonId: string, body: Record<string, unknown>) => req(who.jar, 'PATCH', `/api/hackathons/${hackathonId}/participation`, body)
  const respond = (who: TestUser, proposalId: string, accept: boolean) => req(who.jar, 'POST', `/api/squad-proposals/${proposalId}/respond`, { accept })

  it('lets a registered person join the pool, and nobody else', async () => {
    const h = await hackathon()
    expect((await join(people[0], h.id, { lookingForTeam: true })).data.error.code).toBe('HACKATHON_REGISTRATION_REQUIRED')
    await registerFor(h.id, people[0].userId)
    const joined = await join(people[0], h.id, { openToAutoTeam: true, preferredRoles: ['BACKEND', 'BACKEND', 'DEVOPS'] })
    expect(joined.data).toMatchObject({ lookingForTeam: true, openToAutoTeam: true, preferredRoles: ['BACKEND', 'DEVOPS'] })
    expect((await join(people[0], h.id, { lookingForTeam: false })).data).toMatchObject({ lookingForTeam: false, openToAutoTeam: false })
    expect((await join(people[0], h.id, {})).data.error.code).toBe('VALIDATION_FAILED')
    expect((await join(people[0], h.id, { preferredRoles: ['WIZARD'] })).data.error.code).toBe('VALIDATION_FAILED')
    expect(await testPrisma.productEvent.count({ where: { userId: people[0].userId, name: 'solo_pool_joined' } })).toBe(1)
  })

  it('splits the pool into balanced squads, keeps blocked pairs apart and untrusted accounts out, and runs a round once', async () => {
    const h = await hackathon()
    for (const p of [...people, fresh, closed]) await registerFor(h.id, p.userId)
    for (const p of [...people, fresh]) expect((await join(p, h.id, { openToAutoTeam: true })).status).toBe(200)
    await testPrisma.block.create({ data: { blockerId: people[0].userId, blockedId: people[1].userId } })

    const run = await job('squads/auto-form', { hackathonId: h.id })
    expect(run.status).toBe(200)
    expect(run.data.result.outcomes[0]).toMatchObject({ hackathonId: h.id, round: 1, poolSize: 4, squads: 2, leftovers: 0 })
    const proposals = await testPrisma.squadProposal.findMany({ where: { hackathonId: h.id }, include: { members: true } })
    expect(proposals).toHaveLength(2)
    const placed = proposals.flatMap((p) => p.members.map((m) => m.userId))
    expect(placed.sort()).toEqual(people.map((p) => p.userId).sort())
    expect(placed).not.toContain(fresh.userId)
    for (const proposal of proposals) {
      expect(proposal).toMatchObject({ kind: 'AUTO', status: 'PROPOSED', size: 2 })
      const ids = proposal.members.map((m) => m.userId)
      expect(ids.includes(people[0].userId) && ids.includes(people[1].userId)).toBe(false)
      expect(proposal.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 60_000)
    }
    expect(await testPrisma.notification.count({ where: { userId: { in: placed }, metadata: { path: ['kind'], equals: 'SQUAD_PROPOSAL' } } })).toBe(4)

    // Again: the round already ran.
    const again = await job('squads/auto-form', { hackathonId: h.id, round: 1 })
    expect(again.data.result.outcomes[0].skipped).toBe('ALREADY_RAN')
    expect(await testPrisma.squadProposal.count({ where: { hackathonId: h.id } })).toBe(2)

    // The caller's proposals, and answering one.
    const mine = await req(people[0].jar, 'GET', '/api/squad-proposals')
    const own = mine.data.proposals.find((p: any) => p.hackathonId === h.id)
    expect(own).toMatchObject({ kind: 'AUTO', status: 'PROPOSED', myResponse: 'PENDING' })
    expect((await req(people[0].jar, 'GET', `/api/squad-proposals/${own.id}`)).data.proposal.members).toHaveLength(2)
    expect((await respond(closed, own.id, true)).data.error.code).toBe('SQUAD_PROPOSAL_NOT_FOUND')

    // Squad A: both accept, so it forms with a team, slots filled, and both registered with it.
    const a = proposals.find((p) => p.members.some((m) => m.userId === people[0].userId))!
    const b = proposals.find((p) => p.id !== a.id)!
    const [a1, a2] = a.members.map((m) => people.find((p) => p.userId === m.userId)!)
    expect((await respond(a1, a.id, true)).data.status).toBe('PROPOSED')
    const formed = await respond(a2, a.id, true)
    expect(formed.data.status).toBe('FORMED')
    const teamId = formed.data.teamId
    expect(await testPrisma.teamMember.count({ where: { teamId } })).toBe(2)
    expect(await testPrisma.hackathonTeam.findUnique({ where: { teamId } })).not.toBeNull()
    for (const m of a.members) expect((await testPrisma.hackathonParticipant.findUniqueOrThrow({ where: { userId_hackathonId: { userId: m.userId, hackathonId: h.id } } })).teamId).toBe(teamId)
    expect(await testPrisma.userAchievement.count({ where: { userId: { in: [a1.userId, a2.userId] }, achievement: { slug: 'pool-squad' } } })).toBe(2)
    expect((await respond(a1, a.id, false)).data.error.code).toBe('SQUAD_PROPOSAL_USED')

    // Squad B: one says no, so it fails, and the one who said yes stays in the pool.
    const [b1, b2] = b.members.map((m) => people.find((p) => p.userId === m.userId)!)
    await respond(b1, b.id, true)
    expect((await respond(b2, b.id, false)).data.status).toBe('FAILED')
    expect((await testPrisma.squadFormationRun.findUniqueOrThrow({ where: { hackathonId_round: { hackathonId: h.id, round: 1 } } })).settledAt).not.toBeNull()

    // Round 2 pools the one who said yes again (and not the one who said no): one person is not a squad.
    const second = await job('squads/auto-form', { hackathonId: h.id })
    expect(second.data.result.outcomes[0]).toMatchObject({ round: 2, poolSize: 1, squads: 0, skipped: 'POOL_TOO_SMALL' })
  })

  it('settles squads nobody answered, expires invitations, and reminds teamless registrants once per stage', async () => {
    const h = await hackathon()
    for (const p of [people[2], people[3]]) {
      await registerFor(h.id, p.userId, { lookingForTeam: true, openToAutoTeam: true })
    }
    await registerFor(h.id, closed.userId)
    await req(closed.jar, 'PUT', '/api/notifications/preferences', { preferences: { SQUAD_REMINDER: false } })
    await job('squads/auto-form', { hackathonId: h.id })
    const proposal = await testPrisma.squadProposal.findFirstOrThrow({ where: { hackathonId: h.id } })
    await testPrisma.squadProposal.update({ where: { id: proposal.id }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const sweep = await job('squads/sweep')
    expect(sweep.status).toBe(200)
    expect(sweep.data.result.settled).toBeGreaterThanOrEqual(1)
    expect((await testPrisma.squadProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('FAILED')
    // An answer after the day is up is refused.
    expect((await respond(people[2], proposal.id, true)).data.error.code).toBe('SQUAD_PROPOSAL_USED')

    const reminders = () => testPrisma.notification.count({ where: { coalesceKey: `squad-reminder:${h.id}:T48H` } })
    expect(await reminders()).toBe(2)
    await job('squads/sweep')
    expect(await reminders()).toBe(2)
    expect(await testPrisma.notification.count({ where: { userId: closed.userId, coalesceKey: `squad-reminder:${h.id}:T48H` } })).toBe(0)
  })
})
