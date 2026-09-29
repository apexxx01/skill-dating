import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { promoteToAdmin, cleanupTestUsers } from './db'

// The full core loop, one continuous trace, matching the exact end-to-end
// path verified live by hand earlier this session: register -> project ->
// team -> apply/accept -> messages -> hackathon -> ship -> leaderboard.
// Each step's real effect is asserted from the next step's real response,
// not assumed from the previous call's success.
describe('core loop', () => {
  const suffix = uniqueSuffix()
  const emailA = `coreloop.a.${suffix}@test.dev`
  const emailB = `coreloop.b.${suffix}@test.dev`

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  it('runs register -> discover -> project -> team -> apply/accept -> messages -> hackathon -> ship -> leaderboard', async () => {
    const A = await registerAndLogin(emailA, `coreloopa${suffix}`)
    const B = await registerAndLogin(emailB, `coreloopb${suffix}`)
    await promoteToAdmin(A.userId)

    // discover - B should be findable with a real compatibility score
    let r = await req(A.jar, 'GET', '/api/discover?limit=50')
    expect(r.status).toBe(200)
    const found = r.data.people.find((p: any) => p.id === B.userId)
    expect(found).toBeTruthy()
    expect(typeof found.compatibility).toBe('number')

    // project
    r = await req(A.jar, 'POST', '/api/projects', { name: `Core Loop Project ${suffix}` })
    expect(r.status).toBe(201)
    const projectId = r.data.id

    // team linked to project
    r = await req(A.jar, 'POST', '/api/teams', { name: `Core Loop Team ${suffix}`, projectId })
    expect(r.status).toBe(201)
    const teamId = r.data.id

    // B applies, A accepts
    r = await req(B.jar, 'POST', `/api/teams/${teamId}/applications`, {})
    expect(r.status).toBe(201)
    const appId = r.data.id

    r = await req(A.jar, 'PATCH', `/api/teams/${teamId}/applications/${appId}`, { status: 'ACCEPTED' })
    expect(r.status).toBe(200)

    // B is a real TeamMember + ProjectMember
    r = await req(A.jar, 'GET', `/api/teams/${teamId}`)
    expect(r.status).toBe(200)
    expect(r.data.members.some((m: any) => m.userId === B.userId)).toBe(true)

    r = await req(A.jar, 'GET', `/api/projects/${projectId}`)
    expect(r.status).toBe(200)
    expect(r.data.members.some((m: any) => m.userId === B.userId)).toBe(true)

    // team conversation - both can message
    r = await req(B.jar, 'GET', '/api/conversations')
    const list = r.data.conversations ?? r.data
    const teamConvo = list.find((c: any) => c.teamId === teamId || c.team?.id === teamId)
    expect(teamConvo).toBeTruthy()

    r = await req(A.jar, 'POST', `/api/conversations/${teamConvo.id}`, { content: 'welcome to the team' })
    expect(r.status).toBe(201)
    r = await req(B.jar, 'POST', `/api/conversations/${teamConvo.id}`, { content: 'excited to build' })
    expect(r.status).toBe(201)

    r = await req(A.jar, 'GET', `/api/conversations/${teamConvo.id}`)
    expect(r.data.messages.length).toBeGreaterThanOrEqual(2)

    // hackathon: create, register, team registers
    r = await req(A.jar, 'POST', '/api/hackathons', {
      name: `Core Loop Hackathon ${suffix}`,
      description: 'test',
      startDate: new Date(Date.now() + 86400000).toISOString(),
      endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
    })
    expect(r.status).toBe(201)
    const hackathonId = r.data.id

    r = await req(A.jar, 'POST', `/api/hackathons/${hackathonId}`, { skills: [], lookingFor: [] })
    expect(r.status).toBe(201)

    r = await req(A.jar, 'POST', `/api/hackathons/${hackathonId}/teams`, { teamId, projectId })
    expect(r.status).toBe(200)

    // ship
    r = await req(A.jar, 'PATCH', `/api/projects/${projectId}`, { status: 'SHIPPED' })
    expect(r.status).toBe(200)
    expect(r.data.shippedAt).toBeTruthy()

    // leaderboard - real rank/xp for A
    r = await req(A.jar, 'GET', '/api/leaderboard?limit=100')
    expect(r.status).toBe(200)
    expect(r.data.me.xp).toBeGreaterThan(0)
    expect(r.data.me.rank).toBeGreaterThanOrEqual(1)
  })
})
