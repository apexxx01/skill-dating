import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { dropHackathons, makeHackathon, registerFor } from './squad-fixtures'

// The squad lifecycle around leaving and reporting: a member who leaves reopens their slot and the owner is told who in the pool could fill it, and
// admins get a CSV of the teams (safe to open in a spreadsheet) and the headline numbers (share in a team, median time to team).
describe('the squad lifecycle and organizer data', () => {
  const suffix = uniqueSuffix()
  const hackathons: string[] = []
  let owner: TestUser
  let member: TestUser
  let solo: TestUser
  let admin: TestUser
  let hackathonId: string
  let teamId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    owner = await registerAndLogin(`lco${suffix}@test.dev`, `lco${suffix}`)
    member = await registerAndLogin(`lcm${suffix}@test.dev`, `lcm${suffix}`)
    solo = await registerAndLogin(`lcs${suffix}@test.dev`, `lcs${suffix}`)
    admin = await registerAndLogin(`lca${suffix}@test.dev`, `lca${suffix}`)
    await promoteToAdmin(admin.userId)
    const h = await makeHackathon()
    hackathons.push(h.id)
    hackathonId = h.id
    await registerFor(h.id, owner.userId)
    await registerFor(h.id, member.userId)
    await registerFor(h.id, solo.userId, { lookingForTeam: true, preferredRoles: ['DESIGN_UI_UX'] })
    await testPrisma.hackathonParticipant.updateMany({ where: { hackathonId: h.id }, data: { registeredAt: new Date(Date.now() - 2 * 3600_000) } })
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `=Lifecycle, "Squad" ${suffix}`, hackathonId, slots: [{ role: 'DESIGN_UI_UX' }] })
    teamId = team.data.id
    await req(owner.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId })
    const invitation = await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: member.userId, slotId: team.data.slots[0].id })
    await req(member.jar, 'PATCH', `/api/teams/${teamId}/applications/${invitation.data.id}`, { status: 'ACCEPTED' })
  }, 120_000)
  afterAll(async () => {
    await dropHackathons(hackathons)
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('gives admins the headline numbers', async () => {
    expect((await req(owner.jar, 'GET', `/api/admin/hackathons/${hackathonId}/metrics`)).status).toBe(403)
    const metrics = await req(admin.jar, 'GET', `/api/admin/hackathons/${hackathonId}/metrics`)
    expect(metrics.data).toMatchObject({ hackathonId, registered: 3, inTeam: 2, percentInTeam: 66.7, squads: 1, soloPool: 1 })
    expect(metrics.data.medianMinutesToTeam).toBeGreaterThanOrEqual(110)
    expect(metrics.data.medianMinutesToTeam).toBeLessThanOrEqual(130)
  })

  it('exports the teams as CSV, one row per member, with nothing a spreadsheet would run', async () => {
    expect((await req(member.jar, 'GET', `/api/admin/hackathons/${hackathonId}/teams.csv`)).status).toBe(403)
    const csv = await req(admin.jar, 'GET', `/api/admin/hackathons/${hackathonId}/teams.csv`)
    expect(csv.status).toBe(200)
    const lines = (csv.data as string).trim().split('\r\n')
    expect(lines[0]).toBe('team_id,team_name,rank,score,submitted,project_name,project_url,repo_url,member_id,member_username,member_name,team_role,squad_role,role_label,joined_at')
    expect(lines).toHaveLength(3)
    expect(lines[1].startsWith(`${teamId},"'=Lifecycle, ""Squad"" ${suffix}"`)).toBe(true)
    expect(lines.some((line) => line.includes(member.userId) && line.includes('DESIGN_UI_UX'))).toBe(true)
  })

  it('reopens the slot when a member leaves and tells the owner who in the pool could fill it', async () => {
    const left = await req(member.jar, 'DELETE', `/api/teams/${teamId}/members/${member.userId}`)
    expect(left.data.reopenedSlotId).toBeTruthy()
    // The suggestion is a job that runs after the response.
    let notification = null
    for (let i = 0; i < 40 && !notification; i++) {
      notification = await testPrisma.notification.findFirst({ where: { userId: owner.userId, metadata: { path: ['slotId'], equals: left.data.reopenedSlotId } } })
      if (!notification) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(notification).not.toBeNull()
    expect(notification!.title).toBe('Your Designer (UI/UX) slot is open again')
    expect((notification!.metadata as any).suggestions).toEqual([solo.userId])
  })
})
