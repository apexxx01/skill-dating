import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

// Role slots on a team: created with the team (structured or from an old lookingFor), managed by the owner, applied for and invited to, filled by
// accepting, reopened by leaving; and the squad rules every join follows (the hackathon's size, one squad per hackathon, invitation expiry, the
// submission-deadline lock).
describe('squad role slots', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let n = 0
  let owner: TestUser
  let applicant: TestUser
  let invitee: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    owner = await registerAndLogin(`sqo${suffix}@test.dev`, `sqo${suffix}`)
    applicant = await registerAndLogin(`sqa${suffix}@test.dev`, `sqa${suffix}`)
    invitee = await registerAndLogin(`sqi${suffix}@test.dev`, `sqi${suffix}`)
  }, 120_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await cleanupTestUsers(suffix)
  }, 120_000)

  const team = async (body: Record<string, unknown> = {}, who: TestUser = owner) => req(who.jar, 'POST', '/api/teams', { name: `Slot Team ${suffix} ${n++}`, ...body })
  const hackathon = async (over: Parameters<typeof makeHackathon>[0] = {}) => {
    const h = await makeHackathon(over)
    hackathons.push(h.id)
    return h
  }
  const accept = (who: TestUser, teamId: string, applicationId: string) => req(who.jar, 'PATCH', `/api/teams/${teamId}/applications/${applicationId}`, { status: 'ACCEPTED' })

  it('creates a team with structured slots and an old lookingFor, and derives lookingFor from the open slots', async () => {
    const created = await team({
      maxSize: 5,
      squadRole: 'BACKEND',
      slots: [{ role: 'FRONTEND', requiredSkills: ['React'] }, { role: 'OTHER', customLabel: 'Smart contract developer', requiredSkills: ['Solidity'] }],
      lookingFor: ['Figma'],
    })
    expect(created.status).toBe(201)
    expect(created.data.slots.map((s: any) => [s.role, s.customLabel, s.requiredSkills, s.status])).toEqual([
      ['FRONTEND', null, ['React'], 'OPEN'],
      ['OTHER', 'Smart contract developer', ['Solidity'], 'OPEN'],
      ['DESIGN_UI_UX', null, ['Figma'], 'OPEN'],
    ])
    expect(created.data.lookingFor).toEqual(['React', 'Solidity', 'Figma'])
    const me = await testPrisma.teamMember.findUniqueOrThrow({ where: { userId_teamId: { userId: owner.userId, teamId: created.data.id } } })
    expect(me).toMatchObject({ role: 'OWNER', squadRole: 'BACKEND' })

    // The list filters by an open slot's role.
    const listed = await req(applicant.jar, 'GET', '/api/teams?role=DESIGN_UI_UX&limit=50')
    expect(listed.data.teams.some((t: any) => t.id === created.data.id)).toBe(true)
    const notListed = await req(applicant.jar, 'GET', '/api/teams?role=HARDWARE&limit=50')
    expect(notListed.data.teams.some((t: any) => t.id === created.data.id)).toBe(false)
  })

  it('refuses more structured slots than free places, and an OTHER slot without a label', async () => {
    expect((await team({ maxSize: 2, slots: [{ role: 'FRONTEND' }, { role: 'BACKEND' }] })).data.error.code).toBe('SLOT_LIMIT_REACHED')
    expect((await team({ slots: [{ role: 'OTHER' }] })).data.error.code).toBe('VALIDATION_FAILED')
    // A long legacy list is still accepted as it is.
    const legacy = await team({ maxSize: 2, lookingFor: ['React', 'Go', 'Figma'] })
    expect(legacy.status).toBe(201)
    expect(legacy.data.lookingFor).toEqual(['React', 'Go', 'Figma'])
  })

  it('lets the owner add, edit and remove open slots, nobody else, and never past the free places', async () => {
    const created = await team({ maxSize: 3 })
    const id = created.data.id
    expect((await req(applicant.jar, 'POST', `/api/teams/${id}/slots`, { role: 'FRONTEND' })).data.error.code).toBe('FORBIDDEN')
    const first = await req(owner.jar, 'POST', `/api/teams/${id}/slots`, { role: 'FRONTEND', requiredSkills: ['Vue'] })
    expect(first.status).toBe(201)
    expect((await req(owner.jar, 'POST', `/api/teams/${id}/slots`, { role: 'DATA' })).status).toBe(201)
    expect((await req(owner.jar, 'POST', `/api/teams/${id}/slots`, { role: 'DEVOPS' })).data.error.code).toBe('SLOT_LIMIT_REACHED')

    const edited = await req(owner.jar, 'PATCH', `/api/teams/${id}/slots/${first.data.id}`, { role: 'OTHER', customLabel: 'Game designer', requiredSkills: ['Unity'] })
    expect(edited.data).toMatchObject({ role: 'OTHER', customLabel: 'Game designer', requiredSkills: ['Unity'] })
    expect((await req(owner.jar, 'PATCH', `/api/teams/${id}/slots/${first.data.id}`, { customLabel: null })).data.error.code).toBe('VALIDATION_FAILED')
    expect((await req(applicant.jar, 'PATCH', `/api/teams/${id}/slots/${first.data.id}`, { role: 'DATA' })).data.error.code).toBe('FORBIDDEN')

    const view = await req(applicant.jar, 'GET', `/api/teams/${id}/slots`)
    expect(view.data).toMatchObject({ capacity: 3, memberCount: 1, openPlaces: 2, locked: false })
    expect(view.data.slots).toHaveLength(2)
    expect((await testPrisma.team.findUniqueOrThrow({ where: { id } })).lookingFor).toEqual(['Unity', 'Data engineer'])

    expect((await req(owner.jar, 'DELETE', `/api/teams/${id}/slots/${first.data.id}`)).data).toEqual({ deleted: true })
    expect((await req(owner.jar, 'DELETE', `/api/teams/${id}/slots/${first.data.id}`)).data.error.code).toBe('SLOT_NOT_FOUND')
  })

  it('fills a slot when an application for it is accepted, reopens it when the member leaves, and refuses a second taker', async () => {
    const created = await team({ maxSize: 4, slots: [{ role: 'DESIGN_UI_UX', requiredSkills: ['Figma'] }] })
    const id = created.data.id
    const slotId = created.data.slots[0].id
    expect((await req(applicant.jar, 'POST', `/api/teams/${id}/applications`, { slotId: 'nope' })).data.error.code).toBe('SLOT_NOT_FOUND')
    const application = await req(applicant.jar, 'POST', `/api/teams/${id}/applications`, { slotId, message: 'I design' })
    expect(application.status).toBe(201)
    const invitation = await req(owner.jar, 'POST', `/api/teams/${id}/invitations`, { userId: invitee.userId, slotId })
    expect(invitation.status).toBe(201)
    expect(new Date(invitation.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000)

    expect((await accept(owner, id, application.data.id)).status).toBe(200)
    const slot = await testPrisma.teamSlot.findUniqueOrThrow({ where: { id: slotId } })
    expect(slot).toMatchObject({ status: 'FILLED', filledById: applicant.userId })
    expect(await testPrisma.teamMember.findUniqueOrThrow({ where: { userId_teamId: { userId: applicant.userId, teamId: id } } })).toMatchObject({ squadRole: 'DESIGN_UI_UX' })
    expect((await testPrisma.team.findUniqueOrThrow({ where: { id } })).lookingFor).toEqual([])

    // The invitation for the same slot can no longer be taken.
    expect((await accept(invitee, id, invitation.data.id)).data.error.code).toBe('SLOT_NOT_OPEN')
    expect((await req(owner.jar, 'PATCH', `/api/teams/${id}/slots/${slotId}`, { role: 'DATA' })).data.error.code).toBe('SLOT_NOT_OPEN')

    const left = await req(applicant.jar, 'DELETE', `/api/teams/${id}/members/${applicant.userId}`)
    expect(left.data).toEqual({ success: true, reopenedSlotId: slotId })
    expect(await testPrisma.teamSlot.findUniqueOrThrow({ where: { id: slotId } })).toMatchObject({ status: 'OPEN', filledById: null })
    expect((await testPrisma.team.findUniqueOrThrow({ where: { id } })).lookingFor).toEqual(['Figma'])
  })

  it('lets a member declare their own squad role but not change permissions', async () => {
    const created = await team({ maxSize: 4 })
    const id = created.data.id
    const invitation = await req(owner.jar, 'POST', `/api/teams/${id}/invitations`, { userId: invitee.userId })
    expect((await accept(invitee, id, invitation.data.id)).status).toBe(200)
    expect((await req(invitee.jar, 'PATCH', `/api/teams/${id}/members/${invitee.userId}`, { squadRole: 'OTHER' })).data.error.code).toBe('VALIDATION_FAILED')
    const declared = await req(invitee.jar, 'PATCH', `/api/teams/${id}/members/${invitee.userId}`, { squadRole: 'OTHER', roleLabel: 'Hardware hacker' })
    expect(declared.data).toMatchObject({ squadRole: 'OTHER', roleLabel: 'Hardware hacker', role: 'MEMBER' })
    expect((await req(invitee.jar, 'PATCH', `/api/teams/${id}/members/${invitee.userId}`, { role: 'ADMIN' })).data.error.code).toBe('FORBIDDEN')
    expect((await req(invitee.jar, 'PATCH', `/api/teams/${id}/members/${owner.userId}`, { squadRole: 'DATA' })).data.error.code).toBe('FORBIDDEN')
    const byOwner = await req(owner.jar, 'PATCH', `/api/teams/${id}/members/${invitee.userId}`, { squadRole: 'HARDWARE' })
    expect(byOwner.data).toMatchObject({ squadRole: 'HARDWARE', roleLabel: null })
  })

  it('expires an invitation after 48 hours', async () => {
    const created = await team()
    const invitation = await req(owner.jar, 'POST', `/api/teams/${created.data.id}/invitations`, { userId: invitee.userId })
    await testPrisma.teamApplication.update({ where: { id: invitation.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await accept(invitee, created.data.id, invitation.data.id)).data.error.code).toBe('INVITATION_EXPIRED')
    expect((await testPrisma.teamApplication.findUniqueOrThrow({ where: { id: invitation.data.id } })).status).toBe('EXPIRED')
    // The owner can invite again.
    expect((await req(owner.jar, 'POST', `/api/teams/${created.data.id}/invitations`, { userId: invitee.userId })).status).toBe(201)
  })

  it("keeps a hackathon team within the hackathon's size and its people to one squad", async () => {
    const h = await hackathon({ maxTeamSize: 2 })
    for (const u of [owner, applicant, invitee]) await registerFor(h.id, u.userId)
    const created = await team({ hackathonId: h.id, maxSize: 5 })
    expect(created.data.maxSize).toBe(2)
    expect((await req(owner.jar, 'PATCH', `/api/teams/${created.data.id}`, { maxSize: 4 })).data.error.code).toBe('HACKATHON_TEAM_TOO_LARGE')

    const one = await req(owner.jar, 'POST', `/api/teams/${created.data.id}/invitations`, { userId: applicant.userId })
    const two = await req(owner.jar, 'POST', `/api/teams/${created.data.id}/invitations`, { userId: invitee.userId })
    expect((await accept(applicant, created.data.id, one.data.id)).status).toBe(200)
    expect((await accept(invitee, created.data.id, two.data.id)).data.error.code).toBe('TEAM_FULL')

    // The applicant is in a squad for this hackathon now, so another team of it cannot take them.
    const other = await team({ hackathonId: h.id }, invitee)
    const poach = await req(invitee.jar, 'POST', `/api/teams/${other.data.id}/invitations`, { userId: applicant.userId })
    expect((await accept(applicant, other.data.id, poach.data.id)).data.error.code).toBe('ALREADY_IN_HACKATHON_TEAM')
  })

  it('locks the team at the submission deadline: no joins, no leaving, no slot changes', async () => {
    const h = await hackathon()
    for (const u of [owner, applicant]) await registerFor(h.id, u.userId)
    const created = await team({ hackathonId: h.id, slots: [{ role: 'DATA' }] })
    const id = created.data.id
    const invitation = await req(owner.jar, 'POST', `/api/teams/${id}/invitations`, { userId: applicant.userId })
    expect((await accept(applicant, id, invitation.data.id)).status).toBe(200)
    const lateInvite = await req(owner.jar, 'POST', `/api/teams/${id}/invitations`, { userId: invitee.userId })

    await testPrisma.hackathon.update({ where: { id: h.id }, data: { submissionDeadline: new Date(Date.now() - 60_000) } })
    expect((await accept(invitee, id, lateInvite.data.id)).data.error.code).toBe('TEAM_LOCKED')
    expect((await req(applicant.jar, 'DELETE', `/api/teams/${id}/members/${applicant.userId}`)).data.error.code).toBe('TEAM_LOCKED')
    expect((await req(owner.jar, 'POST', `/api/teams/${id}/slots`, { role: 'DEVOPS' })).data.error.code).toBe('TEAM_LOCKED')
    expect((await req(owner.jar, 'DELETE', `/api/teams/${id}/slots/${created.data.slots[0].id}`)).data.error.code).toBe('TEAM_LOCKED')
    expect((await req(owner.jar, 'POST', `/api/teams/${id}/invitations`, { userId: invitee.userId })).data.error.code).toBe('TEAM_LOCKED')
    expect((await req(applicant.jar, 'GET', `/api/teams/${id}/slots`)).data.locked).toBe(true)
  })
})
