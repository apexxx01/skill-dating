import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { cleanupTestUsers } from './db'

// A regression-test subset of the manual authorization sweep run earlier
// this session (Phase 3 item 5) - the highest-value two-actor and
// ownership cases, so a future change that quietly breaks one of them
// fails CI instead of waiting for another manual sweep.
describe('authorization', () => {
  const suffix = uniqueSuffix()

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  it('rejects unauthenticated access to a protected route', async () => {
    const r = await req(null, 'GET', '/api/projects')
    expect(r.status).toBe(401)
  })

  it('only the project owner (or admin) can PATCH/DELETE it', async () => {
    const owner = await registerAndLogin(`authz.owner.${suffix}@test.dev`, `authzowner${suffix}`)
    const stranger = await registerAndLogin(`authz.stranger.${suffix}@test.dev`, `authzstranger${suffix}`)

    const created = await req(owner.jar, 'POST', '/api/projects', { name: `Authz Project ${suffix}` })
    const projectId = created.data.id

    const patchAsStranger = await req(stranger.jar, 'PATCH', `/api/projects/${projectId}`, { description: 'hijack' })
    expect(patchAsStranger.status).toBe(403)

    const deleteAsStranger = await req(stranger.jar, 'DELETE', `/api/projects/${projectId}`)
    expect(deleteAsStranger.status).toBe(403)
  })

  it('only a connection request\'s receiver can accept/decline it, not the sender', async () => {
    const sender = await registerAndLogin(`authz.sender.${suffix}@test.dev`, `authzsender${suffix}`)
    const receiver = await registerAndLogin(`authz.receiver.${suffix}@test.dev`, `authzreceiver${suffix}`)

    const conn = await req(sender.jar, 'POST', '/api/connections', { receiverId: receiver.userId, type: 'NETWORK' })
    expect(conn.status).toBe(201)

    const senderTriesToAccept = await req(sender.jar, 'PATCH', `/api/connections/${conn.data.id}`, { status: 'ACCEPTED' })
    expect(senderTriesToAccept.status).toBe(403)

    const receiverAccepts = await req(receiver.jar, 'PATCH', `/api/connections/${conn.data.id}`, { status: 'ACCEPTED' })
    expect(receiverAccepts.status).toBe(200)
  })

  it('a team invitation can only be accepted by the invitee, not an unrelated user', async () => {
    const owner = await registerAndLogin(`authz.towner.${suffix}@test.dev`, `authztowner${suffix}`)
    const invitee = await registerAndLogin(`authz.invitee.${suffix}@test.dev`, `authzinvitee${suffix}`)
    const unrelated = await registerAndLogin(`authz.unrelated.${suffix}@test.dev`, `authzunrelated${suffix}`)

    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Authz Invite Team ${suffix}` })
    const teamId = team.data.id

    const invite = await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: invitee.userId })
    expect(invite.status).toBe(201)

    const unrelatedTriesToAccept = await req(unrelated.jar, 'PATCH', `/api/teams/${teamId}/applications/${invite.data.id}`, { status: 'ACCEPTED' })
    expect(unrelatedTriesToAccept.status).toBe(403)

    const inviteeAccepts = await req(invitee.jar, 'PATCH', `/api/teams/${teamId}/applications/${invite.data.id}`, { status: 'ACCEPTED' })
    expect(inviteeAccepts.status).toBe(200)
  })

  it('a regular user cannot list or resolve reports; a moderator can', async () => {
    const reporter = await registerAndLogin(`authz.reporter.${suffix}@test.dev`, `authzreporter${suffix}`)
    const reported = await registerAndLogin(`authz.reported.${suffix}@test.dev`, `authzreported${suffix}`)

    const report = await req(reporter.jar, 'POST', '/api/reports', { reportedId: reported.userId, reason: 'SPAM' })
    expect(report.status).toBe(201)

    const regularUserLists = await req(reporter.jar, 'GET', '/api/reports')
    expect(regularUserLists.status).toBe(403)
  })
})
