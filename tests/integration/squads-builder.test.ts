import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

// "Find my squad" and squad strength: a complete squad proposed around the caller from the hackathon's solo pool (registered, teamless, looking for
// a team, trusted, never someone they blocked), its invitations sent in one call, the invitees joining their slots, the strength of the team that
// results, and the registration of a squad with its hackathon being idempotent.
describe('the squad builder and squad strength', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let requester: TestUser
  let pool: TestUser[]
  let blocked: TestUser
  let notLooking: TestUser
  let outsider: TestUser
  let hackathonId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    requester = await registerAndLogin(`sbr${suffix}@test.dev`, `sbr${suffix}`)
    pool = []
    for (let i = 0; i < 4; i++) pool.push(await registerAndLogin(`sbp${i}${suffix}@test.dev`, `sbp${i}${suffix}`))
    blocked = await registerAndLogin(`sbb${suffix}@test.dev`, `sbb${suffix}`)
    notLooking = await registerAndLogin(`sbn${suffix}@test.dev`, `sbn${suffix}`)
    outsider = await registerAndLogin(`sbo${suffix}@test.dev`, `sbo${suffix}`)

    const h = await makeHackathon({ technologies: ['React', 'Python', 'Figma'], minTeamSize: 2, maxTeamSize: 4 })
    hackathons.push(h.id)
    hackathonId = h.id
    await registerFor(h.id, requester.userId, { lookingForTeam: true })
    const roles = ['FRONTEND', 'BACKEND', 'DESIGN_UI_UX', 'PITCH_BUSINESS'] as const
    for (let i = 0; i < pool.length; i++) await registerFor(h.id, pool[i].userId, { lookingForTeam: true, preferredRoles: [roles[i]] })
    await registerFor(h.id, blocked.userId, { lookingForTeam: true, preferredRoles: ['FRONTEND'] })
    await registerFor(h.id, notLooking.userId, { lookingForTeam: false, preferredRoles: ['BACKEND'] })
    await testPrisma.block.create({ data: { blockerId: blocked.userId, blockedId: requester.userId } })
  }, 180_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await cleanupTestUsers(suffix)
  }, 120_000)

  const propose = (who: TestUser, body: Record<string, unknown> = {}) => req(who.jar, 'POST', `/api/hackathons/${hackathonId}/squad-builder`, body)

  it('refuses someone who is not registered, and an unknown track', async () => {
    expect((await propose(outsider)).data.error.code).toBe('HACKATHON_REGISTRATION_REQUIRED')
    const unknown = await propose(requester, { tracks: ['Nope'] })
    expect(unknown.data.error.code).toBe('TRACK_NOT_FOUND')
    expect(unknown.data.error.params).toEqual({ tracks: 'Nope' })
  })

  it('proposes a complete squad of the default size from the pool, never the blocked or the not-looking, the same for the same seed', async () => {
    const first = await propose(requester, { seed: 7 })
    expect(first.status).toBe(201)
    const proposal = first.data.proposal
    expect(proposal).toMatchObject({ hackathonId, kind: 'BUILDER', status: 'OPEN', size: 4, seed: 7, teamId: null })
    const ids = proposal.members.map((m: any) => m.person.id)
    expect(ids).toHaveLength(4)
    expect(ids).toContain(requester.userId)
    expect(ids).not.toContain(blocked.userId)
    expect(ids).not.toContain(notLooking.userId)
    expect(ids.every((id: string) => [requester.userId, ...pool.map((p) => p.userId)].includes(id))).toBe(true)
    expect(proposal.members.find((m: any) => m.person.id === requester.userId)).toMatchObject({ onTeam: true, reasons: [] })
    for (const member of proposal.members) {
      expect(typeof member.role).toBe('string')
      expect(typeof member.roleLabel).toBe('string')
    }
    expect(proposal.strength.score).toBeGreaterThanOrEqual(0)
    expect(proposal.strength.score).toBeLessThanOrEqual(100)
    expect(Object.keys(proposal.strength.components).sort()).toEqual(['chemistry', 'commitmentFit', 'experienceMix', 'roleCoverage', 'skillCoverage', 'timezoneOverlap'])
    expect(Array.isArray(proposal.strength.gaps)).toBe(true)
    expect(new Date(proposal.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000)

    const again = await propose(requester, { seed: 7 })
    expect(again.data.proposal.members.map((m: any) => m.person.id)).toEqual(ids)
    expect(again.data.proposal.id).not.toBe(proposal.id)

    // Read back by its owner; nobody else sees it.
    expect((await req(requester.jar, 'GET', `/api/hackathons/${hackathonId}/squad-builder/${proposal.id}`)).data.proposal.id).toBe(proposal.id)
    expect((await req(outsider.jar, 'GET', `/api/hackathons/${hackathonId}/squad-builder/${proposal.id}`)).data.error.code).toBe('SQUAD_PROPOSAL_NOT_FOUND')
  })

  it('invites everyone proposed in one call, once, then the invitees fill their slots and the team has a strength', async () => {
    const proposal = (await propose(requester, { seed: 11 })).data.proposal
    const key = `sb-invite-${suffix}`
    const invited = await req(requester.jar, 'POST', `/api/hackathons/${hackathonId}/squad-builder/${proposal.id}/invite`, { teamName: `Builder Squad ${suffix}` }, { 'Idempotency-Key': key })
    expect(invited.status).toBe(201)
    expect(invited.data.created).toBe(true)
    expect(invited.data.invitations).toHaveLength(3)
    expect(invited.data.skipped).toEqual([])
    const teamId = invited.data.teamId

    // The same key answers the same; another call is refused, the proposal is used.
    const replay = await req(requester.jar, 'POST', `/api/hackathons/${hackathonId}/squad-builder/${proposal.id}/invite`, { teamName: `Builder Squad ${suffix}` }, { 'Idempotency-Key': key })
    expect(replay.data.teamId).toBe(teamId)
    expect((await req(requester.jar, 'POST', `/api/hackathons/${hackathonId}/squad-builder/${proposal.id}/invite`, {})).data.error.code).toBe('SQUAD_PROPOSAL_USED')
    expect(await testPrisma.team.count({ where: { name: `Builder Squad ${suffix}` } })).toBe(1)

    // The team is registered with the hackathon from the start, and the requester with it.
    expect(await testPrisma.hackathonTeam.findUnique({ where: { teamId } })).not.toBeNull()
    expect((await testPrisma.hackathonParticipant.findUniqueOrThrow({ where: { userId_hackathonId: { userId: requester.userId, hackathonId } } })).teamId).toBe(teamId)

    // Each invitation targets an open slot of the proposed role and is good for 48 hours.
    const invitations = await testPrisma.teamApplication.findMany({ where: { teamId }, include: { slot: true } })
    for (const invitation of invitations) {
      expect(invitation).toMatchObject({ status: 'PENDING', invitedById: requester.userId, proposalId: proposal.id })
      expect(invitation.slot?.status).toBe('OPEN')
      expect(invitation.expiresAt!.getTime() - Date.now()).toBeGreaterThan(47 * 3600_000)
    }
    const notified = await testPrisma.notification.count({ where: { userId: { in: invitations.map((i) => i.userId) }, metadata: { path: ['proposalId'], equals: proposal.id } } })
    expect(notified).toBe(3)

    // An invitee accepts: they fill their slot and are entered with the hackathon registration.
    const first = invitations[0]
    const firstUser = pool.find((p) => p.userId === first.userId)!
    expect((await req(firstUser.jar, 'PATCH', `/api/teams/${teamId}/applications/${first.id}`, { status: 'ACCEPTED' })).status).toBe(200)
    expect(await testPrisma.teamSlot.findUniqueOrThrow({ where: { id: first.slotId! } })).toMatchObject({ status: 'FILLED', filledById: first.userId })
    const participant = await testPrisma.hackathonParticipant.findUniqueOrThrow({ where: { userId_hackathonId: { userId: first.userId, hackathonId } } })
    expect(participant.teamId).toBe(teamId)
    expect(participant.teamJoinedAt).not.toBeNull()

    // Registering the squad with the hackathon again is a no-op that answers the same, not ALREADY_IN_HACKATHON_TEAM.
    const register = await req(firstUser.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId })
    expect(register.status).toBe(200)
    expect(register.data.teamId).toBe(teamId)
    expect((await req(firstUser.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId })).status).toBe(200)

    // The owner was paid once for the filled slot.
    expect(await testPrisma.xPEvent.count({ where: { userId: requester.userId, type: 'SQUAD_SLOT_FILLED', sourceId: first.slotId! } })).toBe(1)

    // The team's strength, for its members and nobody else.
    const strength = await req(firstUser.jar, 'GET', `/api/teams/${teamId}/strength`)
    expect(strength.status).toBe(200)
    expect(strength.data).toMatchObject({ teamId, hackathonId, memberCount: 2, capacity: 4, pledgesExpected: true })
    expect(strength.data.gaps.map((g: any) => g.code)).toContain('MISSING_ROLE')
    expect(strength.data.gaps.map((g: any) => g.code)).toContain('UNCONFIRMED_PLEDGES')
    expect(strength.data.roles.length).toBe(4)
    expect(JSON.stringify(strength.data)).not.toMatch(/reliability/)
    expect((await req(outsider.jar, 'GET', `/api/teams/${teamId}/strength`)).data.error.code).toBe('FORBIDDEN')

    // Two members and two people invited fill the four places: the builder proposes nobody more for this team.
    expect((await propose(requester)).data.error.code).toBe('SQUAD_COMPLETE')
  })

  it('refuses an expired proposal', async () => {
    const h = await makeHackathon({ minTeamSize: 2, maxTeamSize: 3 })
    hackathons.push(h.id)
    await registerFor(h.id, outsider.userId, { lookingForTeam: true })
    await registerFor(h.id, notLooking.userId, { lookingForTeam: true })
    const made = await req(outsider.jar, 'POST', `/api/hackathons/${h.id}/squad-builder`, { size: 2 })
    expect(made.status).toBe(201)
    expect(made.data.proposal.members.map((m: any) => m.person.id).sort()).toEqual([outsider.userId, notLooking.userId].sort())
    await testPrisma.squadProposal.update({ where: { id: made.data.proposal.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await req(outsider.jar, 'POST', `/api/hackathons/${h.id}/squad-builder/${made.data.proposal.id}/invite`, {})).data.error.code).toBe('SQUAD_PROPOSAL_EXPIRED')
    // Somebody else's proposal is not found.
    expect((await req(requester.jar, 'POST', `/api/hackathons/${h.id}/squad-builder/${made.data.proposal.id}/invite`, {})).data.error.code).toBe('SQUAD_PROPOSAL_NOT_FOUND')
  })
})
