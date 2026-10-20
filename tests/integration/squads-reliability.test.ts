import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

const DAY = 24 * 3600_000

// Reliability: commitment pledges before a hackathon (flagged in strength until made, closed at the start), private peer reviews of teammates in
// the week after the end (once per pair, teammates only, an untrusted reviewer kept but not counted), reliability recomputed and only ever shown
// as the passport badge, admin-only notes, the review prompt sent once, and a mutual "no" never paired again by the builder.
describe('pledges, peer reviews and reliability', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let owner: TestUser
  let mate: TestUser
  let freshMate: TestUser
  let outsider: TestUser
  let admin: TestUser
  let hackathonId: string
  let teamId: string

  const hackathon = async (over: Parameters<typeof makeHackathon>[0] = {}) => {
    const h = await makeHackathon(over)
    hackathons.push(h.id)
    return h
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    owner = await registerAndLogin(`rlo${suffix}@test.dev`, `rlo${suffix}`)
    mate = await registerAndLogin(`rlm${suffix}@test.dev`, `rlm${suffix}`)
    freshMate = await registerAndLogin(`rlf${suffix}@test.dev`, `rlf${suffix}`, undefined, { fresh: true })
    outsider = await registerAndLogin(`rlx${suffix}@test.dev`, `rlx${suffix}`)
    admin = await registerAndLogin(`rla${suffix}@test.dev`, `rla${suffix}`)
    await promoteToAdmin(admin.userId)
    const h = await hackathon({ startDate: new Date(Date.now() + 5 * DAY), endDate: new Date(Date.now() + 7 * DAY) })
    hackathonId = h.id
    for (const u of [owner, mate, freshMate]) await registerFor(h.id, u.userId)
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Reliable Squad ${suffix}`, hackathonId })
    teamId = team.data.id
    await req(owner.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId })
    for (const u of [mate, freshMate]) {
      const invitation = await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: u.userId })
      expect((await req(u.jar, 'PATCH', `/api/teams/${teamId}/applications/${invitation.data.id}`, { status: 'ACCEPTED' })).status).toBe(200)
    }
  }, 180_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await cleanupTestUsers(suffix)
  }, 120_000)

  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
  const pledge = (who: TestUser, body: Record<string, unknown>) => req(who.jar, 'PUT', `/api/teams/${teamId}/pledge`, body)
  const review = (who: TestUser, body: Record<string, unknown>) => req(who.jar, 'POST', `/api/hackathons/${hackathonId}/peer-reviews`, body)

  it('takes a pledge from a member before the start, within the dates, and flags who has none', async () => {
    const good = { attendance: 'REMOTE', hoursAvailable: 20, availableFrom: day(5), availableUntil: day(7) }
    expect((await pledge(outsider, good)).data.error.code).toBe('FORBIDDEN')
    expect((await pledge(mate, { ...good, availableUntil: day(30) })).data.error.code).toBe('PLEDGE_DATES_OUTSIDE')
    const made = await pledge(mate, good)
    expect(made.status).toBe(200)
    expect(made.data).toMatchObject({ attendance: 'REMOTE', hoursAvailable: 20, availableFrom: day(5) })
    expect((await pledge(mate, { ...good, attendance: 'IN_PERSON', hoursAvailable: 30 })).data.hoursAvailable).toBe(30)
    expect(await testPrisma.commitmentPledge.count({ where: { hackathonId, userId: mate.userId } })).toBe(1)

    const strength = await req(owner.jar, 'GET', `/api/teams/${teamId}/strength`)
    expect(strength.data.gaps.find((g: any) => g.code === 'UNCONFIRMED_PLEDGES').message).toBe('2 members have not confirmed their commitment pledge')
    const space = await req(owner.jar, 'GET', `/api/teams/${teamId}/space`)
    expect(space.data.unconfirmedPledges.sort()).toEqual([owner.userId, freshMate.userId].sort())
    expect(space.data.roles.find((r: any) => r.userId === mate.userId).pledge).toMatchObject({ attendance: 'IN_PERSON', hoursAvailable: 30 })

    await testPrisma.hackathon.update({ where: { id: hackathonId }, data: { startDate: new Date(Date.now() - DAY) } })
    expect((await pledge(owner, good)).data.error.code).toBe('PLEDGE_CLOSED')
  })

  it('opens reviews at the end, for teammates only, once per pair, and counts only trusted reviewers', async () => {
    const body = { revieweeId: mate.userId, showedUp: 'YES', wouldBuildAgain: true, note: 'Carried the backend' }
    expect((await review(owner, body)).data.error.code).toBe('PEER_REVIEW_WINDOW_CLOSED')
    await testPrisma.hackathon.update({ where: { id: hackathonId }, data: { status: 'ENDED', endDate: new Date(Date.now() - 1000) } })

    const todo = await req(owner.jar, 'GET', `/api/hackathons/${hackathonId}/peer-reviews`)
    expect(todo.data.window.open).toBe(true)
    expect(todo.data.teammates.map((t: any) => [t.userId, t.reviewed]).sort()).toEqual([[mate.userId, false], [freshMate.userId, false]].sort())
    expect((await req(outsider.jar, 'GET', `/api/hackathons/${hackathonId}/peer-reviews`)).data.error.code).toBe('NOT_TEAMMATES')

    expect((await review(owner, { ...body, revieweeId: outsider.userId })).data.error.code).toBe('NOT_TEAMMATES')
    expect((await review(owner, { ...body, revieweeId: owner.userId })).data.error.code).toBe('NOT_TEAMMATES')
    const written = await review(owner, body)
    expect(written.status).toBe(201)
    expect(written.data).not.toHaveProperty('counted')
    expect((await review(owner, body)).data.error.code).toBe('PEER_REVIEW_EXISTS')
    const stored = await testPrisma.userReliability.findUniqueOrThrow({ where: { userId: mate.userId } })
    expect(stored).toMatchObject({ reviews: 1, badge: false })

    // An account the trust gate does not trust: its review is kept, and changes nothing.
    expect((await review(freshMate, { revieweeId: owner.userId, showedUp: 'NO', wouldBuildAgain: false })).status).toBe(201)
    expect(await testPrisma.peerReview.findFirstOrThrow({ where: { hackathonId, reviewerId: freshMate.userId } })).toMatchObject({ counted: false })
    expect(await testPrisma.userReliability.findUnique({ where: { userId: owner.userId } })).toBeNull()

    // What was said, back to its author only.
    const after = await req(owner.jar, 'GET', `/api/hackathons/${hackathonId}/peer-reviews`)
    expect(after.data.teammates.find((t: any) => t.userId === mate.userId)).toMatchObject({ reviewed: true, mine: { showedUp: 'YES', wouldBuildAgain: true } })
    expect(JSON.stringify((await req(mate.jar, 'GET', `/api/hackathons/${hackathonId}/peer-reviews`)).data)).not.toContain('Carried the backend')
  })

  it('shows notes to admins only, and the badge, never the number, once there are enough good reviews', async () => {
    expect((await req(owner.jar, 'GET', `/api/admin/hackathons/${hackathonId}/peer-reviews`)).status).toBe(403)
    const notes = await req(admin.jar, 'GET', `/api/admin/hackathons/${hackathonId}/peer-reviews`)
    expect(notes.data.reviews.find((r: any) => r.reviewerId === owner.userId)).toMatchObject({ note: 'Carried the backend', counted: true })

    expect((await req(outsider.jar, 'GET', `/api/users/${mate.userId}`)).data.reliableTeammate).toBe(false)
    // One good review so far: two more from earlier hackathons, then one through the API recomputes it from all four.
    for (let i = 0; i < 2; i++) {
      const old = await hackathon()
      await testPrisma.peerReview.create({ data: { hackathonId: old.id, reviewerId: outsider.userId, revieweeId: mate.userId, showedUp: 'YES', wouldBuildAgain: true } })
    }
    const third = await hackathon({ status: 'ENDED', startDate: new Date(Date.now() - 3 * DAY), endDate: new Date(Date.now() - DAY) })
    await registerFor(third.id, owner.userId)
    await registerFor(third.id, mate.userId)
    const ht = await testPrisma.hackathonTeam.create({ data: { hackathonId: third.id, teamId: (await testPrisma.team.create({ data: { name: `Old Squad ${suffix}`, slug: `old-squad-${suffix}`, ownerId: owner.userId } })).id, name: 'Old Squad' } })
    await testPrisma.hackathonTeamMember.createMany({ data: [{ hackathonTeamId: ht.id, userId: owner.userId, role: 'OWNER' }, { hackathonTeamId: ht.id, userId: mate.userId, role: 'MEMBER' }] })
    expect((await req(owner.jar, 'POST', `/api/hackathons/${third.id}/peer-reviews`, { revieweeId: mate.userId, showedUp: 'YES', wouldBuildAgain: true })).status).toBe(201)
    expect(await testPrisma.userReliability.findUniqueOrThrow({ where: { userId: mate.userId } })).toMatchObject({ reviews: 4, badge: true })

    const profile = await req(outsider.jar, 'GET', `/api/users/${mate.userId}`)
    expect(profile.data.reliableTeammate).toBe(true)
    expect(JSON.stringify(profile.data)).not.toMatch(/reliability|"score"/)
  })

  it('asks squads to review each other once, and never pairs a mutual no again', async () => {
    const sweep = () => req(admin.jar, 'POST', '/api/admin/jobs/squads/sweep', {})
    expect((await sweep()).status).toBe(200)
    const prompts = () => testPrisma.notification.count({ where: { coalesceKey: `peer-review:${hackathonId}` } })
    expect(await prompts()).toBe(3)
    await sweep()
    expect(await prompts()).toBe(3)

    // The fresh mate said no about the owner; the owner says no back: a mutual no. The builder never puts them together again.
    expect((await review(owner, { revieweeId: freshMate.userId, showedUp: 'NO', wouldBuildAgain: false })).status).toBe(201)
    const next = await hackathon()
    await registerFor(next.id, owner.userId, { lookingForTeam: true })
    await registerFor(next.id, freshMate.userId, { lookingForTeam: true })
    // The fresh mate is not trusted yet; make them so, so only the mutual no can keep them apart.
    await testPrisma.user.update({ where: { id: freshMate.userId }, data: { createdAt: new Date(Date.now() - 30 * DAY), isEmailVerified: true } })
    expect((await req(owner.jar, 'POST', `/api/hackathons/${next.id}/squad-builder`, { size: 2 })).data.error.code).toBe('SQUAD_POOL_EMPTY')
  })
})
