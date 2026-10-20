import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

// The looking-for-group board: one active post per person per hackathon, PERSON posts by registered people without a squad and TEAM posts by whoever
// runs the team, filters, ranking and cursor pages, blocked people hidden both ways, and only the author edits or takes a post down.
describe('the looking-for-group board', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser
  let blocker: TestUser
  let hackathonId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    alice = await registerAndLogin(`lfa${suffix}@test.dev`, `lfa${suffix}`)
    bob = await registerAndLogin(`lfb${suffix}@test.dev`, `lfb${suffix}`)
    carol = await registerAndLogin(`lfc${suffix}@test.dev`, `lfc${suffix}`)
    blocker = await registerAndLogin(`lfx${suffix}@test.dev`, `lfx${suffix}`)
    const h = await makeHackathon()
    hackathons.push(h.id)
    hackathonId = h.id
    for (const u of [alice, bob, blocker]) await registerFor(h.id, u.userId)
    await testPrisma.block.create({ data: { blockerId: blocker.userId, blockedId: carol.userId } })
  }, 120_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await cleanupTestUsers(suffix)
  }, 120_000)

  const board = (who: TestUser, query = '') => req(who.jar, 'GET', `/api/hackathons/${hackathonId}/lfg${query}`)
  const post = (who: TestUser, body: Record<string, unknown>, headers: Record<string, string> = {}) => req(who.jar, 'POST', `/api/hackathons/${hackathonId}/lfg`, body, headers)

  it('takes one active PERSON post per registered person, and refuses the unregistered', async () => {
    expect((await post(carol, { kind: 'PERSON', roles: ['DESIGN_UI_UX'], note: 'Designer here' })).data.error.code).toBe('HACKATHON_REGISTRATION_REQUIRED')
    const key = `lfg-${suffix}`
    const body = { kind: 'PERSON', roles: ['BACKEND', 'BACKEND'], stack: ['Go', 'go', 'Postgres'], timezone: 'Europe/Berlin', note: 'Backend, looking for a squad' }
    const created = await post(alice, body, { 'Idempotency-Key': key })
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({ kind: 'PERSON', roles: ['BACKEND'], stack: ['go', 'postgres'], timezone: 'Europe/Berlin', mine: true, fit: null, team: null })
    expect((await post(alice, body, { 'Idempotency-Key': key })).data.id).toBe(created.data.id)
    const second = await post(alice, { kind: 'PERSON', roles: ['DATA'], note: 'Another' })
    expect(second.data.error.code).toBe('LFG_ACTIVE_POST_EXISTS')
    expect(second.data.error.details).toEqual({ postId: created.data.id })
    expect((await post(alice, { kind: 'PERSON', roles: ['DATA'], note: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() })).data.error.code).toBe('VALIDATION_FAILED')
  })

  it('takes a TEAM post only from whoever runs a team of this hackathon', async () => {
    const team = await req(bob.jar, 'POST', '/api/teams', { name: `LFG Team ${suffix}`, hackathonId })
    expect((await post(alice, { kind: 'TEAM', teamId: team.data.id, roles: ['FRONTEND'], note: 'Join us' })).data.error.code).toBe('FORBIDDEN')
    const created = await post(bob, { kind: 'TEAM', teamId: team.data.id, roles: ['FRONTEND', 'DESIGN_UI_UX'], stack: ['React'], timezone: 'America/New_York', note: 'We need a frontend' })
    expect(created.status).toBe(201)
    expect(created.data.team).toMatchObject({ id: team.data.id })
    // Bob is in a squad now, so a PERSON post of his would make no sense.
    await req(bob.jar, 'DELETE', `/api/hackathons/${hackathonId}/lfg/${created.data.id}`)
    expect((await post(bob, { kind: 'PERSON', roles: ['BACKEND'], note: 'x' })).data.error.code).toBe('ALREADY_IN_HACKATHON_TEAM')
    expect((await post(bob, { kind: 'TEAM', teamId: team.data.id, roles: ['FRONTEND'], stack: ['React'], timezone: 'America/New_York', note: 'We need a frontend' })).status).toBe(201)
  })

  it('filters, ranks with a fit for the viewer, pages with a cursor, and hides blocked people both ways', async () => {
    const all = await board(alice)
    expect(all.status).toBe(200)
    const ids = all.data.posts.map((p: any) => p.author.id)
    expect(ids).toContain(alice.userId)
    expect(ids).toContain(bob.userId)
    const bobs = all.data.posts.find((p: any) => p.author.id === bob.userId)
    expect(typeof bobs.fit.score).toBe('number')
    expect(Array.isArray(bobs.fit.reasons)).toBe(true)

    expect((await board(alice, '?role=FRONTEND')).data.posts.map((p: any) => p.author.id)).toEqual([bob.userId])
    expect((await board(alice, '?stack=GO')).data.posts.map((p: any) => p.author.id)).toEqual([alice.userId])
    expect((await board(alice, '?kind=TEAM')).data.posts.map((p: any) => p.kind)).toEqual(['TEAM'])
    expect((await board(alice, '?tz=Europe/Paris')).data.posts.map((p: any) => p.author.id)).toEqual([alice.userId])
    expect((await board(alice, '?role=WIZARD')).data.error.code).toBe('VALIDATION_FAILED')
    expect((await board(alice, '?cursor=nonsense')).data.error.code).toBe('INVALID_CURSOR')

    const first = await board(alice, '?limit=1')
    expect(first.data.posts).toHaveLength(1)
    expect(first.data.nextCursor).toBeTruthy()
    const rest = await board(alice, `?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`)
    expect(rest.data.posts).toHaveLength(1)
    expect(rest.data.posts[0].id).not.toBe(first.data.posts[0].id)

    // The blocker's post is hidden from the person they blocked, and that person's board is the same for the blocker.
    await post(blocker, { kind: 'PERSON', roles: ['ML_AI'], note: 'ML person' })
    expect((await board(carol)).data.posts.map((p: any) => p.author.id)).not.toContain(blocker.userId)
    expect((await board(alice)).data.posts.map((p: any) => p.author.id)).toContain(blocker.userId)
  })

  it('lets only the author edit or take a post down, and closes a PERSON post when they join a squad', async () => {
    const mine = (await board(alice)).data.posts.find((p: any) => p.author.id === alice.userId)
    expect((await req(bob.jar, 'PATCH', `/api/hackathons/${hackathonId}/lfg/${mine.id}`, { note: 'hijack' })).data.error.code).toBe('FORBIDDEN')
    const edited = await req(alice.jar, 'PATCH', `/api/hackathons/${hackathonId}/lfg/${mine.id}`, { note: 'Backend and data', roles: ['BACKEND', 'DATA'] })
    expect(edited.data).toMatchObject({ note: 'Backend and data', roles: ['BACKEND', 'DATA'] })
    expect((await req(alice.jar, 'PATCH', `/api/hackathons/${hackathonId}/lfg/${mine.id}`, {})).data.error.code).toBe('VALIDATION_FAILED')
    expect((await req(bob.jar, 'DELETE', `/api/hackathons/${hackathonId}/lfg/${mine.id}`)).data.error.code).toBe('FORBIDDEN')

    // Alice joins Bob's team: her PERSON post closes by itself.
    const team = await testPrisma.team.findFirstOrThrow({ where: { name: `LFG Team ${suffix}` } })
    const invitation = await req(bob.jar, 'POST', `/api/teams/${team.id}/invitations`, { userId: alice.userId })
    expect((await req(alice.jar, 'PATCH', `/api/teams/${team.id}/applications/${invitation.data.id}`, { status: 'ACCEPTED' })).status).toBe(200)
    expect((await testPrisma.lfgPost.findUniqueOrThrow({ where: { id: mine.id } })).closedAt).not.toBeNull()
    expect((await req(alice.jar, 'DELETE', `/api/hackathons/${hackathonId}/lfg/${mine.id}`)).data.error.code).toBe('LFG_POST_NOT_FOUND')
  })
})
