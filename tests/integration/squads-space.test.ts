import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

// A squad's team space: the view (roles, countdown, slots, checklist, ideas, pledges) for members only, the checklist, the idea board with votes and
// one chosen idea, target tracks validated against the hackathon's, "post our demo" co-authored by the squad, and "keep building" after the end.
describe('the hackathon team space', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let owner: TestUser
  let member: TestUser
  let outsider: TestUser
  let hackathonId: string
  let teamId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    owner = await registerAndLogin(`tso${suffix}@test.dev`, `tso${suffix}`)
    member = await registerAndLogin(`tsm${suffix}@test.dev`, `tsm${suffix}`)
    outsider = await registerAndLogin(`tsx${suffix}@test.dev`, `tsx${suffix}`)
    const h = await makeHackathon({ tracks: [{ name: 'Best use of AI', description: 'LLMs and agents' }, { name: 'DeFi', description: 'Web3 finance' }], submissionDeadline: new Date(Date.now() + 11 * 24 * 3600_000) })
    hackathons.push(h.id)
    hackathonId = h.id
    for (const u of [owner, member]) await registerFor(h.id, u.userId)
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Space Squad ${suffix}`, hackathonId, squadRole: 'BACKEND', slots: [{ role: 'DESIGN_UI_UX' }] })
    teamId = team.data.id
    await req(owner.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId })
    const invitation = await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: member.userId })
    await req(member.jar, 'PATCH', `/api/teams/${teamId}/applications/${invitation.data.id}`, { status: 'ACCEPTED' })
  }, 120_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await testPrisma.project.deleteMany({ where: { name: { contains: suffix } } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('shows the space to members only, with roles, the countdown, open slots and missing pledges', async () => {
    expect((await req(outsider.jar, 'GET', `/api/teams/${teamId}/space`)).data.error.code).toBe('FORBIDDEN')
    const space = await req(member.jar, 'GET', `/api/teams/${teamId}/space`)
    expect(space.status).toBe(200)
    expect(space.data.team).toMatchObject({ id: teamId, keptBuildingAt: null })
    expect(space.data.hackathon).toMatchObject({ id: hackathonId, locked: false, unverified: false })
    expect(space.data.hackathon.secondsLeft).toBeGreaterThan(10 * 24 * 3600)
    expect(space.data.hackathon.tracks.map((t: any) => t.name)).toEqual(['Best use of AI', 'DeFi'])
    expect(space.data.roles.find((r: any) => r.userId === owner.userId)).toMatchObject({ teamRole: 'OWNER', squadRole: 'BACKEND', roleLabel: 'Backend developer' })
    expect(space.data.openSlots.map((s: any) => s.role)).toEqual(['DESIGN_UI_UX'])
    expect(space.data.unconfirmedPledges.sort()).toEqual([owner.userId, member.userId].sort())
  })

  it('validates target tracks against the hackathon and keeps its spelling', async () => {
    expect((await req(owner.jar, 'PATCH', `/api/teams/${teamId}`, { targetTracks: ['Gaming'] })).data.error.code).toBe('TRACK_NOT_FOUND')
    const set = await req(owner.jar, 'PATCH', `/api/teams/${teamId}`, { targetTracks: ['best use of ai'] })
    expect(set.data.targetTracks).toEqual(['Best use of AI'])
    // The squad builder's template follows the track: an AI track wants an ML engineer.
    const strength = await req(owner.jar, 'GET', `/api/teams/${teamId}/strength`)
    expect(strength.data.roles.map((r: any) => r.key)).toContain('ML_AI')
  })

  it('keeps a shared checklist for members, with assignees who are members', async () => {
    expect((await req(outsider.jar, 'POST', `/api/teams/${teamId}/checklist`, { title: 'Nope' })).data.error.code).toBe('FORBIDDEN')
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/checklist`, { title: 'Deploy', assigneeId: outsider.userId })).data.error.code).toBe('VALIDATION_FAILED')
    const item = await req(owner.jar, 'POST', `/api/teams/${teamId}/checklist`, { title: 'Deploy the API', assigneeId: member.userId })
    expect(item.status).toBe(201)
    const done = await req(member.jar, 'PATCH', `/api/teams/${teamId}/checklist/${item.data.id}`, { done: true })
    expect(done.data.done).toBe(true)
    expect(done.data.doneAt).not.toBeNull()
    const undone = await req(member.jar, 'PATCH', `/api/teams/${teamId}/checklist/${item.data.id}`, { done: false })
    expect(undone.data.doneAt).toBeNull()
    expect((await req(member.jar, 'GET', `/api/teams/${teamId}/space`)).data.checklist[0]).toMatchObject({ title: 'Deploy the API', assignee: { id: member.userId } })
    expect((await req(owner.jar, 'DELETE', `/api/teams/${teamId}/checklist/${item.data.id}`)).data).toEqual({ deleted: true })
    expect((await req(owner.jar, 'DELETE', `/api/teams/${teamId}/checklist/${item.data.id}`)).data.error.code).toBe('CHECKLIST_ITEM_NOT_FOUND')
  })

  it('runs an idea board: post, vote once, unvote, and one chosen idea', async () => {
    const a = await req(member.jar, 'POST', `/api/teams/${teamId}/ideas`, { title: 'Agent that triages issues', description: 'Uses an LLM' })
    const b = await req(owner.jar, 'POST', `/api/teams/${teamId}/ideas`, { title: 'DeFi dashboard' })
    expect(a.status).toBe(201)
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/ideas/${a.data.id}/vote`)).data.voteCount).toBe(1)
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/ideas/${a.data.id}/vote`)).data.voteCount).toBe(1)
    expect((await req(member.jar, 'POST', `/api/teams/${teamId}/ideas/${a.data.id}/vote`)).data.voteCount).toBe(2)
    expect((await req(member.jar, 'DELETE', `/api/teams/${teamId}/ideas/${a.data.id}/vote`)).data.voteCount).toBe(1)
    expect((await req(outsider.jar, 'POST', `/api/teams/${teamId}/ideas/${a.data.id}/vote`)).data.error.code).toBe('FORBIDDEN')
    expect((await req(member.jar, 'POST', `/api/teams/${teamId}/ideas/${a.data.id}/choose`)).data.error.code).toBe('FORBIDDEN')
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/ideas/${b.data.id}/choose`)).status).toBe(200)
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/ideas/${a.data.id}/choose`)).status).toBe(200)
    const ideas = (await req(owner.jar, 'GET', `/api/teams/${teamId}/space`)).data.ideas
    expect(ideas.map((i: any) => [i.title, i.chosen, i.voteCount, i.votedByMe])).toEqual([
      ['Agent that triages issues', true, 1, true],
      ['DeFi dashboard', false, 0, false],
    ])
    expect((await req(member.jar, 'DELETE', `/api/teams/${teamId}/ideas/${b.data.id}`)).data.error.code).toBe('FORBIDDEN')
  })

  it('posts the demo on the feed, co-authored by the squad', async () => {
    const posted = await req(owner.jar, 'POST', `/api/teams/${teamId}/demo-post`, { title: 'Our hackathon demo', body: 'Here is what we built.' })
    expect(posted.status).toBe(201)
    const row = await testPrisma.shipPost.findUniqueOrThrow({ where: { id: posted.data.post.id } })
    expect(row).toMatchObject({ kind: 'DEMO', teamId, authorId: owner.userId, coAuthorIds: [member.userId] })
    expect((await req(outsider.jar, 'POST', `/api/teams/${teamId}/demo-post`, { title: 'Not ours', body: 'x' })).data.error.code).toBe('FORBIDDEN')
  })

  it('keeps building after the end: a permanent crew with a project from the chosen idea, once', async () => {
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/keep-building`, {})).data.error.code).toBe('KEEP_BUILDING_TOO_EARLY')
    await testPrisma.hackathon.update({ where: { id: hackathonId }, data: { status: 'ENDED', endDate: new Date(Date.now() - 1000), submissionDeadline: new Date(Date.now() - 2000) } })
    expect((await req(member.jar, 'POST', `/api/teams/${teamId}/keep-building`, {})).data.error.code).toBe('FORBIDDEN')
    const kept = await req(owner.jar, 'POST', `/api/teams/${teamId}/keep-building`, {})
    expect(kept.status).toBe(200)
    expect(kept.data.projectCreated).toBe(true)
    const team = await testPrisma.team.findUniqueOrThrow({ where: { id: teamId }, include: { project: { include: { members: true } }, members: true } })
    expect(team.keptBuildingAt).not.toBeNull()
    expect(team.hackathonId).toBeNull()
    expect(team.project?.name).toBe('Agent that triages issues')
    expect(team.project?.members.map((m) => m.userId).sort()).toEqual([owner.userId, member.userId].sort())
    expect(team.members.find((m) => m.userId === owner.userId)?.squadRole).toBe('BACKEND')
    expect((await testPrisma.hackathonTeam.findUniqueOrThrow({ where: { teamId } })).projectId).toBe(team.projectId)
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/keep-building`, {})).data.error.code).toBe('KEEP_BUILDING_DONE')
    // The crew is no longer locked to the hackathon: it can take people again.
    const space = await req(owner.jar, 'GET', `/api/teams/${teamId}/space`)
    expect(space.data.hackathon).toMatchObject({ id: hackathonId, locked: false })
    expect((await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: outsider.userId })).status).toBe(201)
  })
})
