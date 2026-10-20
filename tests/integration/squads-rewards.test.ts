import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

// What a squad earns: submitting pays each member once per hackathon and each joiner once more, the first squad and a reunion with the same people
// unlock their achievements, a squad below the hackathon's minimum cannot submit, and an unverified external hackathon pays nothing at all.
describe('squad rewards', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let owner: TestUser
  let member: TestUser
  let n = 0

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    owner = await registerAndLogin(`srwo${suffix}@test.dev`, `srwo${suffix}`)
    member = await registerAndLogin(`srwm${suffix}@test.dev`, `srwm${suffix}`)
  }, 120_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await testPrisma.project.deleteMany({ where: { name: { contains: suffix } } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  const xp = (userId: string, type: string, sourceId: string) => testPrisma.xPEvent.count({ where: { userId, type, sourceId } })

  /** A registered squad of the owner and the member for an ACTIVE hackathon, with a project. */
  async function squadFor(over: Parameters<typeof makeHackathon>[0] = {}) {
    // Registered alone under a minimum of 1, which is then raised: like a builder or pool squad, registered before it is full.
    const h = await makeHackathon({ status: 'ACTIVE', startDate: new Date(Date.now() - 3600_000), minTeamSize: 1, ...over })
    hackathons.push(h.id)
    for (const u of [owner, member]) await registerFor(h.id, u.userId)
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Reward Squad ${suffix} ${n++}`, hackathonId: h.id })
    expect(team.status).toBe(201)
    expect((await req(owner.jar, 'POST', `/api/hackathons/${h.id}/teams`, { teamId: team.data.id })).status).toBe(200)
    await testPrisma.hackathon.update({ where: { id: h.id }, data: { minTeamSize: 2 } })
    const project = await testPrisma.project.create({ data: { name: `Reward Project ${suffix} ${n}`, slug: `reward-project-${suffix}-${n}`, description: 'x', ownerId: owner.userId } })
    await testPrisma.team.update({ where: { id: team.data.id }, data: { projectId: project.id } })
    return { h, teamId: team.data.id as string }
  }
  async function addMember(teamId: string) {
    const invitation = await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: member.userId })
    expect((await req(member.jar, 'PATCH', `/api/teams/${teamId}/applications/${invitation.data.id}`, { status: 'ACCEPTED' })).status).toBe(200)
  }

  it('refuses a squad below the minimum, then pays each member once for submitting and the joiner once for staying', async () => {
    const { h, teamId } = await squadFor()
    expect((await req(owner.jar, 'POST', `/api/hackathons/${h.id}/submit`, { teamId })).data.error.code).toBe('HACKATHON_TEAM_TOO_SMALL')
    await addMember(teamId)
    // The accepted invitee was entered with the squad's registration automatically.
    expect((await testPrisma.hackathonParticipant.findUniqueOrThrow({ where: { userId_hackathonId: { userId: member.userId, hackathonId: h.id } } })).teamId).toBe(teamId)

    const submitted = await req(member.jar, 'POST', `/api/hackathons/${h.id}/submit`, { teamId })
    expect(submitted.status).toBe(200)
    expect(submitted.data.participantsUpdated).toBe(2)
    expect(submitted.data.rewards.xpGained).toBeGreaterThan(0)
    expect(await xp(owner.userId, 'SQUAD_SUBMITTED', h.id)).toBe(1)
    expect(await xp(member.userId, 'SQUAD_SUBMITTED', h.id)).toBe(1)
    expect(await xp(member.userId, 'SQUAD_JOIN_CONFIRMED', h.id)).toBe(1)
    expect(await xp(owner.userId, 'SQUAD_JOIN_CONFIRMED', h.id)).toBe(0)
    expect(await testPrisma.userAchievement.count({ where: { userId: { in: [owner.userId, member.userId] }, achievement: { slug: 'first-squad' } } })).toBe(2)

    // Submitting again changes nothing and pays nothing.
    const again = await req(owner.jar, 'POST', `/api/hackathons/${h.id}/submit`, { teamId })
    expect(again.data.participantsUpdated).toBe(0)
    expect(await xp(owner.userId, 'SQUAD_SUBMITTED', h.id)).toBe(1)
    expect(await testPrisma.userAchievement.count({ where: { userId: owner.userId, achievement: { slug: 'reunite' } } })).toBe(0)
  })

  it('recognises a reunion: a second hackathon with the same two people', async () => {
    const { h, teamId } = await squadFor()
    await addMember(teamId)
    expect((await req(owner.jar, 'POST', `/api/hackathons/${h.id}/submit`, { teamId })).status).toBe(200)
    expect(await testPrisma.userAchievement.count({ where: { userId: { in: [owner.userId, member.userId] }, achievement: { slug: 'reunite' } } })).toBe(2)
  })

  it('pays nothing for an unverified external hackathon: not joining, not forming, not submitting', async () => {
    const h = await makeHackathon({ source: 'EXTERNAL', externalUrl: `https://devpost.com/reward-${suffix}`, platform: 'DEVPOST', verifiedAt: null, minTeamSize: 1 })
    hackathons.push(h.id)
    expect((await req(owner.jar, 'POST', `/api/hackathons/${h.id}`, {})).status).toBe(201)
    expect(await xp(owner.userId, 'HACKATHON_JOIN', h.id)).toBe(0)

    const team = await req(owner.jar, 'POST', '/api/teams', { name: `External Squad ${suffix}`, hackathonId: h.id })
    expect((await req(owner.jar, 'POST', `/api/hackathons/${h.id}/teams`, { teamId: team.data.id })).status).toBe(200)
    expect(await xp(owner.userId, 'TEAM_FORMED', h.id)).toBe(0)

    const project = await testPrisma.project.create({ data: { name: `External Project ${suffix}`, slug: `external-project-${suffix}`, description: 'x', ownerId: owner.userId } })
    await testPrisma.team.update({ where: { id: team.data.id }, data: { projectId: project.id } })
    await testPrisma.hackathon.update({ where: { id: h.id }, data: { status: 'ACTIVE' } })
    expect((await req(owner.jar, 'POST', `/api/hackathons/${h.id}/submit`, { teamId: team.data.id })).status).toBe(200)
    expect(await xp(owner.userId, 'SQUAD_SUBMITTED', h.id)).toBe(0)
  })
})
