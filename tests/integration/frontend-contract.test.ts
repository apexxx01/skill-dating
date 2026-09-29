import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'

// Pins the response shapes promised in docs/FRONTEND_CONTRACT.md and typed in
// src/types/api.ts, plus the backend gaps closed for the pages that were
// running on mock data.
describe('frontend contract', () => {
  const suffix = uniqueSuffix()
  let n = 0
  const created: { hackathons: string[] } = { hackathons: [] }

  afterAll(async () => {
    await testPrisma.hackathon.deleteMany({ where: { id: { in: created.hackathons } } })
    await cleanupTestUsers(suffix)
  })

  async function user(label: string): Promise<TestUser> {
    const name = `fc${label}${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  const pagination = expect.objectContaining({
    page: expect.any(Number),
    limit: expect.any(Number),
    total: expect.any(Number),
    totalPages: expect.any(Number),
  })

  it('profile: email only for self, live rank, blockedByMe, compatibility', async () => {
    const a = await user('pa')
    const b = await user('pb')
    const emailA = (await testPrisma.user.findUnique({ where: { id: a.userId } }))!.email

    const self = await req(a.jar, 'GET', `/api/users/${a.userId}`)
    expect(self.status).toBe(200)
    expect(self.data.email).toBe(emailA)
    expect(self.data.compatibility).toBeNull()
    expect(self.data.blockedByMe).toBe(false)

    const other = await req(b.jar, 'GET', `/api/users/${a.userId}`)
    expect(other.status).toBe(200)
    expect(other.data).not.toHaveProperty('email')
    expect(JSON.stringify(other.data)).not.toContain(emailA)
    expect(typeof other.data.compatibility).toBe('number')
    for (const key of ['skills', 'skillEvidences', 'ownedProjects', 'projects', 'ownedTeams', 'teams', 'achievements', 'currentBuild', 'rank', 'xp']) {
      expect(other.data, key).toHaveProperty(key)
    }

    // The stored rank column is never updated; the profile reports the live one.
    await testPrisma.xPEvent.create({ data: { userId: a.userId, type: 'PROJECT_CREATED', amount: 500, description: 'seed' } })
    const ranked = await req(b.jar, 'GET', `/api/users/${a.userId}`)
    expect(ranked.data.rank).toBeGreaterThanOrEqual(1)

    await req(b.jar, 'POST', '/api/blocks', { userId: a.userId })
    expect((await req(b.jar, 'GET', `/api/users/${a.userId}`)).data.blockedByMe).toBe(true)
    expect((await req(a.jar, 'GET', `/api/users/${b.userId}`)).status).toBe(404)
  })

  it('activity: own feed in full, others limited to public or shared projects, blocks hide it', async () => {
    const owner = await user('ao')
    const viewer = await user('av')
    const member = await user('am')

    const pub = await req(owner.jar, 'POST', '/api/projects', { name: `Fc Public ${suffix}${n++}`, isPublic: true })
    const priv = await req(owner.jar, 'POST', '/api/projects', { name: `Fc Private ${suffix}${n++}`, isPublic: false })
    await testPrisma.projectMember.create({ data: { projectId: priv.data.id, userId: member.userId } })

    const ownFeed = await req(owner.jar, 'GET', '/api/activity')
    expect(ownFeed.status).toBe(200)
    expect(ownFeed.data.pagination).toEqual(pagination)
    const ownProjects = ownFeed.data.activity.map((a: any) => a.project?.id).filter(Boolean)
    expect(ownProjects).toEqual(expect.arrayContaining([pub.data.id, priv.data.id]))
    for (const key of ['id', 'userId', 'type', 'title', 'description', 'link', 'metadata', 'createdAt', 'project']) {
      expect(ownFeed.data.activity[0], key).toHaveProperty(key)
    }

    const asViewer = await req(viewer.jar, 'GET', `/api/activity?userId=${owner.userId}`)
    expect(asViewer.status).toBe(200)
    const seen = asViewer.data.activity.map((a: any) => a.project?.id).filter(Boolean)
    expect(seen).toContain(pub.data.id)
    expect(seen).not.toContain(priv.data.id)
    expect(asViewer.data.pagination.total).toBeLessThan(ownFeed.data.pagination.total)

    const asMember = await req(member.jar, 'GET', `/api/activity?userId=${owner.userId}`)
    expect(asMember.data.activity.map((a: any) => a.project?.id)).toContain(priv.data.id)

    expect((await req(viewer.jar, 'GET', '/api/activity?userId=no-such-user')).status).toBe(404)

    await req(owner.jar, 'POST', '/api/blocks', { userId: viewer.userId })
    expect((await req(viewer.jar, 'GET', `/api/activity?userId=${owner.userId}`)).status).toBe(404)

    const filtered = await req(owner.jar, 'GET', '/api/activity?type=PROJECT_CREATED&limit=5')
    expect(filtered.data.activity.every((a: any) => a.type === 'PROJECT_CREATED')).toBe(true)
    expect((await req(owner.jar, 'GET', '/api/activity?limit=500')).status).toBe(400)
  })

  it('hackathon list: registered, myTeamId and myStatus reflect the signed-in user', async () => {
    const a = await user('ha')
    const b = await user('hb')
    await promoteToAdmin(a.userId)
    const hackathon = await req(a.jar, 'POST', '/api/hackathons', {
      name: `Fc Hackathon ${suffix}${n++}`,
      description: 'contract',
      startDate: new Date(Date.now() + 86400000).toISOString(),
      endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
    })
    expect(hackathon.status).toBe(201)
    created.hackathons.push(hackathon.data.id)

    const find = async (viewer: TestUser) => {
      const res = await req(viewer.jar, 'GET', '/api/hackathons?limit=50')
      expect(res.status).toBe(200)
      expect(res.data.pagination).toEqual(pagination)
      return res.data.hackathons.find((h: any) => h.id === hackathon.data.id)
    }

    expect(await find(a)).toMatchObject({ registered: false, myTeamId: null, myStatus: null })

    expect((await req(a.jar, 'POST', `/api/hackathons/${hackathon.data.id}`, { skills: [], lookingFor: [] })).status).toBe(201)
    expect(await find(a)).toMatchObject({ registered: true, myTeamId: null, myStatus: 'REGISTERED' })
    expect(await find(b)).toMatchObject({ registered: false, myTeamId: null, myStatus: null })

    const team = await req(a.jar, 'POST', '/api/teams', { name: `Fc Hack Team ${suffix}${n++}` })
    const project = await req(a.jar, 'POST', '/api/projects', { name: `Fc Hack Project ${suffix}${n++}` })
    expect((await req(a.jar, 'POST', `/api/hackathons/${hackathon.data.id}/teams`, { teamId: team.data.id, projectId: project.data.id })).status).toBe(200)
    expect(await find(a)).toMatchObject({ registered: true, myTeamId: team.data.id })

    const row = await find(a)
    for (const key of ['id', 'name', 'slug', 'description', 'startDate', 'endDate', 'status', '_count']) {
      expect(row, key).toHaveProperty(key)
    }
    expect(row._count).toEqual({ participants: 1, teams: expect.any(Number) })
  })

  it('conversations: type and search filters, unreadCount and totalUnread', async () => {
    const a = await user('ca')
    const b = await user('cb')
    const c = await user('cc')

    const dm = await req(a.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [b.userId] })
    expect(dm.status).toBe(201)
    const group = await req(a.jar, 'POST', '/api/conversations', { type: 'GROUP', name: `Zebra Crew ${suffix}`, participantIds: [c.userId] })
    expect(group.status).toBe(201)
    await req(b.jar, 'POST', `/api/conversations/${dm.data.id}`, { content: 'hello there' })

    const all = await req(a.jar, 'GET', '/api/conversations')
    expect(all.status).toBe(200)
    expect(all.data.totalUnread).toBe(1)
    expect(all.data.pagination).toEqual(pagination)
    const dmRow = all.data.conversations.find((x: any) => x.id === dm.data.id)
    expect(dmRow.name).toBeNull()
    expect(dmRow.unreadCount).toBe(1)
    expect(dmRow.messages).toHaveLength(1)
    expect(dmRow.messages[0].content).toBe('hello there')
    for (const key of ['id', 'type', 'name', 'members', 'messages', '_count', 'unreadCount', 'updatedAt']) {
      expect(dmRow, key).toHaveProperty(key)
    }

    const onlyGroups = await req(a.jar, 'GET', '/api/conversations?type=GROUP')
    expect(onlyGroups.data.conversations.map((x: any) => x.id)).toEqual([group.data.id])
    expect(onlyGroups.data.pagination.total).toBe(1)

    const byGroupName = await req(a.jar, 'GET', `/api/conversations?search=zebra%20crew`)
    expect(byGroupName.data.conversations.map((x: any) => x.id)).toEqual([group.data.id])

    // A direct conversation has no name: it is found by the other member's name.
    const otherName = (await testPrisma.user.findUnique({ where: { id: b.userId } }))!.name!
    const byPerson = await req(a.jar, 'GET', `/api/conversations?search=${encodeURIComponent(otherName)}`)
    expect(byPerson.data.conversations.map((x: any) => x.id)).toContain(dm.data.id)

    // Searching never matches the caller's own name against every conversation.
    const none = await req(a.jar, 'GET', '/api/conversations?search=definitely-not-anything')
    expect(none.data.conversations).toEqual([])
    expect((await req(a.jar, 'GET', '/api/conversations?type=NOPE')).status).toBe(400)
  })

  it('leaderboard: me carries the live rank and reflects blocks', async () => {
    const a = await user('la')
    const top = await user('lt')
    await testPrisma.xPEvent.create({ data: { userId: a.userId, type: 'PROJECT_CREATED', amount: 100, description: 'seed' } })
    await testPrisma.xPEvent.create({ data: { userId: top.userId, type: 'PROJECT_CREATED', amount: 900000, description: 'seed' } })

    const before = await req(a.jar, 'GET', '/api/leaderboard?limit=100')
    expect(before.data.me.xp).toBe(100)
    expect(before.data.me.rank).toBeGreaterThan(1)
    for (const key of ['rank', 'xp', 'user']) expect(before.data.entries[0], key).toHaveProperty(key)

    await req(a.jar, 'POST', '/api/blocks', { userId: top.userId })
    const after = await req(a.jar, 'GET', '/api/leaderboard?limit=100')
    expect(after.data.me.rank).toBe(before.data.me.rank - 1)
    expect(after.data.entries.map((e: any) => e.user.id)).not.toContain(top.userId)
  })

  it('dashboard: every section is present, and blocked users never appear in recommendations', async () => {
    const a = await user('da')
    const b = await user('db')
    const skill = await testPrisma.skill.create({
      data: { name: `Fc Skill ${suffix}${n++}`, slug: `fc-skill-${suffix}-${n}`, category: 'Test' },
    })
    await testPrisma.userSkill.createMany({
      data: [
        { userId: a.userId, skillId: skill.id, level: 3 },
        { userId: b.userId, skillId: skill.id, level: 3 },
      ],
    })
    const team = await req(b.jar, 'POST', '/api/teams', { name: `Fc Dash Team ${suffix}${n++}`, isRecruiting: true, lookingFor: [skill.name] })
    expect(team.status).toBe(201)

    const first = await req(a.jar, 'GET', '/api/dashboard')
    expect(first.status).toBe(200)
    for (const key of [
      'currentBuild', 'userProjects', 'userTeams', 'hackathonParticipations', 'userQuests', 'recentActivities',
      'xpEvents', 'userSkills', 'recommendedBuilders', 'recruitingTeams', 'upcomingHackathons',
    ]) {
      expect(first.data, key).toHaveProperty(key)
    }
    expect(first.data.recruitingTeams.map((t: any) => t.id)).toContain(team.data.id)
    expect(first.data.recommendedBuilders.map((u: any) => u.id)).toContain(b.userId)

    await req(a.jar, 'POST', '/api/blocks', { userId: b.userId })
    const after = await req(a.jar, 'GET', '/api/dashboard')
    expect(after.data.recommendedBuilders.map((u: any) => u.id)).not.toContain(b.userId)
    expect(after.data.recruitingTeams.map((t: any) => t.id)).not.toContain(team.data.id)

    // Symmetric: the blocked side loses the blocker too.
    const asB = await req(b.jar, 'GET', '/api/dashboard')
    expect(asB.data.recommendedBuilders.map((u: any) => u.id)).not.toContain(a.userId)

    const body = JSON.stringify(after.data)
    expect(body).not.toContain('passwordHash')
    expect(body).not.toMatch(/\$2[aby]\$\d{2}\$/)
    expect((await req(null, 'GET', '/api/dashboard')).status).toBe(401)
  })

  it('discover, projects and teams keep the fields the pages read', async () => {
    const a = await user('xa')
    const b = await user('xb')
    await req(b.jar, 'POST', '/api/projects', { name: `Fc List Project ${suffix}${n++}` })
    await req(b.jar, 'POST', '/api/teams', { name: `Fc List Team ${suffix}${n++}` })

    const discover = await req(a.jar, 'GET', '/api/discover?limit=5')
    expect(discover.status).toBe(200)
    expect(discover.data.pagination).toEqual(pagination)
    for (const key of ['id', 'name', 'username', 'image', 'headline', 'builderRole', 'skills', 'compatibility']) {
      expect(discover.data.people[0], key).toHaveProperty(key)
    }

    const projects = await req(a.jar, 'GET', '/api/projects?limit=5')
    expect(projects.data.pagination).toEqual(pagination)
    for (const key of ['id', 'name', 'slug', 'status', 'owner', 'techStack', 'updatedAt', '_count']) {
      expect(projects.data.projects[0], key).toHaveProperty(key)
    }
    // There is no star or fork data: the mock's counters have no API equivalent.
    expect(projects.data.projects[0]).not.toHaveProperty('stars')
    expect(projects.data.projects[0]).not.toHaveProperty('forks')

    const teams = await req(a.jar, 'GET', '/api/teams?limit=5')
    expect(teams.data.pagination).toEqual(pagination)
    for (const key of ['id', 'name', 'slug', 'owner', 'isRecruiting', 'maxSize', 'lookingFor', '_count']) {
      expect(teams.data.teams[0], key).toHaveProperty(key)
    }
  })
})
