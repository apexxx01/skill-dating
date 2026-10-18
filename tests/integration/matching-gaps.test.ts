import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { bornYearsAgo, daysAgo, makePerson, makeSkills, removePeople, type FixtureOptions } from './matching-fixtures'

const DAY_MS = 24 * 60 * 60 * 1000

describe('GET /api/teams/{id}/gaps', () => {
  const suffix = uniqueSuffix()
  const tag = `gp${suffix}`
  let slugs: string[] = []
  let ml = ''
  let react = ''
  let go = ''
  let owner: TestUser
  let teamAdmin: TestUser
  let plainMember: TestUser
  let outsider: TestUser
  let platformAdmin: TestUser
  let teamId = ''
  let projectId = ''
  const names = new Map<string, string>()

  const person = (options: Partial<FixtureOptions> = {}) => makePerson({ tag, types: ['COLLABORATOR'], ...options })
  const gaps = (u: TestUser | null, id: string = teamId) => req(u?.jar ?? null, 'GET', `/api/teams/${id}/gaps`)
  const ids = (res: { data: { candidates: { person: { id: string } }[] } }) => res.data.candidates.map((c) => c.person.id)

  beforeAll(async () => {
    slugs = await makeSkills(tag, ['ml', 'react', 'go'])
    ;[ml, react, go] = slugs
    for (const slug of slugs) names.set(slug, slug) // the fixtures name a skill after its slug
    owner = await registerAndLogin(`${tag}.owner@test.dev`, `${tag}owner`)
    teamAdmin = await registerAndLogin(`${tag}.tadmin@test.dev`, `${tag}tadmin`)
    plainMember = await registerAndLogin(`${tag}.member@test.dev`, `${tag}member`)
    outsider = await registerAndLogin(`${tag}.outsider@test.dev`, `${tag}outsider`)
    platformAdmin = await registerAndLogin(`${tag}.padmin@test.dev`, `${tag}padmin`)
    await promoteToAdmin(platformAdmin.userId)

    const skill = (slug: string) => testPrisma.skill.findUniqueOrThrow({ where: { slug } })
    await testPrisma.userSkill.create({ data: { userId: owner.userId, skillId: (await skill(react)).id, level: 4 } })
    await testPrisma.user.update({ where: { id: owner.userId }, data: { builderRole: 'Frontend developer', lastActiveAt: new Date() } })
    await testPrisma.matchingProfile.create({ data: { userId: owner.userId, connectionTypes: ['COLLABORATOR'] } })

    const project = await testPrisma.project.create({
      data: { name: `Gap Project ${suffix}`, slug: `gap-project-${suffix}`, ownerId: owner.userId, techStack: [react, 'Vercel'], lookingFor: ['Designer'] },
    })
    projectId = project.id
    const team = await req(owner.jar, 'POST', '/api/teams', { name: `Gap Crew ${suffix}`, maxSize: 6, lookingFor: [ml, 'Growth'], projectId })
    expect(team.status, JSON.stringify(team.data)).toBe(201)
    teamId = team.data.id
    await testPrisma.teamMember.createMany({
      data: [
        { userId: teamAdmin.userId, teamId, role: 'ADMIN' },
        { userId: plainMember.userId, teamId, role: 'MEMBER' },
      ],
    })
    await testPrisma.userSkill.create({ data: { userId: plainMember.userId, skillId: (await skill(go)).id, level: 3 } })
  }, 180_000)

  afterAll(async () => {
    await removePeople(tag)
    await testPrisma.project.deleteMany({ where: { id: projectId } })
    await testPrisma.skill.deleteMany({ where: { slug: { in: slugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  describe('who may ask', () => {
    it('needs a signed-in user, and a team that exists', async () => {
      expect((await gaps(null)).status).toBe(401)
      const missing = await gaps(owner, 'no-such-team')
      expect(missing.status).toBe(404)
      expect(missing.data.error.code).toBe('TEAM_NOT_FOUND')
    })

    it('answers the owner, an admin of the team, and a platform admin, and nobody else', async () => {
      for (const allowed of [owner, teamAdmin, platformAdmin]) expect((await gaps(allowed)).status).toBe(200)
      for (const refused of [plainMember, outsider]) {
        const res = await gaps(refused)
        expect(res.status).toBe(403)
        expect(res.data.error.code).toBe('FORBIDDEN')
      }
    })
  })

  describe('what the team is missing', () => {
    it('sets declared needs and the project’s stack against what the members can do', async () => {
      const res = await gaps(owner)
      expect(res.status).toBe(200)
      expect(res.data.team).toEqual({ id: teamId, name: `Gap Crew ${suffix}`, maxSize: 6, memberCount: 3, openSlots: 3 })
      expect(res.data.needs).toEqual({ team: [ml, 'Growth'], project: ['Designer'], stack: [react, 'Vercel'] })
      // ML is wanted and nobody has it; React is wanted by the stack and the owner has it; Designer and Growth are roles nobody on the team holds.
      expect(res.data.missing.skills).toEqual([{ name: ml, slug: ml, sources: ['TEAM_NEEDS'] }])
      expect(res.data.covered.skills).toEqual([{ name: react, slug: react, sources: ['PROJECT_STACK'], memberIds: [owner.userId] }])
      expect(res.data.missing.roles).toEqual([
        { name: 'Designer', sources: ['PROJECT_NEEDS'] },
        { name: 'Growth', sources: ['TEAM_NEEDS'] },
      ])
      expect(res.data.covered.roles).toEqual([])
      expect(res.data.unmatchedStack).toEqual(['Vercel'])
    })

    it('treats a role a member holds as covered', async () => {
      await testPrisma.user.update({ where: { id: plainMember.userId }, data: { builderRole: 'Product designer' } })
      const res = await gaps(owner)
      expect(res.data.missing.roles.map((r: { name: string }) => r.name)).toEqual(['Growth'])
      expect(res.data.covered.roles).toEqual([{ name: 'Designer', sources: ['PROJECT_NEEDS'], memberIds: [plainMember.userId] }])
      await testPrisma.user.update({ where: { id: plainMember.userId }, data: { builderRole: null } })
    })
  })

  describe('who could fill it', () => {
    it('ranks people who have the missing skills first and explains why, at most five', async () => {
      const mlSkill = await testPrisma.skill.findUniqueOrThrow({ where: { slug: ml } })
      const best = await person({ skills: [[ml, 5]], xp: 20000 })
      await testPrisma.skillEvidence.createMany({ data: [1, 2, 3].map((n) => ({ userId: best.id, skillId: mlSkill.id, type: 'GITHUB_PROJECT', title: `ML ${n}`, verifiedAt: new Date() })) })
      const some = await person({ skills: [[ml, 2]] })
      const others = []
      // Decent fits too (they have some ML), so that there are more than five to choose from.
      for (let i = 0; i < 6; i++) others.push(await person({ skills: [[ml, 2], [go, 3]] }))
      const res = await gaps(owner)
      expect(res.status).toBe(200)
      expect(res.data.candidates.length).toBeLessThanOrEqual(5)
      expect(res.data.candidates).toHaveLength(5)
      const scores = res.data.candidates.map((c: { score: number }) => c.score)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
      expect(ids(res)[0]).toBe(best.id)
      expect(ids(res).length).toBe(5)
      expect(some.id).toBeTruthy()
      const first = res.data.candidates[0]
      expect(first.fills).toEqual([ml])
      expect(first.connectionType).toBe('COLLABORATOR')
      expect(first.reasons[0]).toBe(`You need ${ml}, they have 3 verified ${ml} projects`)
      expect(Object.keys(first).sort()).toEqual(['connectionType', 'fills', 'person', 'reasons', 'score'])
      expect(Object.keys(first.person).sort()).toEqual(['builderRole', 'headline', 'id', 'image', 'level', 'location', 'name', 'proof', 'skills', 'tier', 'username'])
      expect(JSON.stringify(res.data)).not.toMatch(/email|birthDate|@test\.dev/i)
    })

    it('leaves out the people a drop would leave out, and the team itself', async () => {
      const control = await person({ skills: [[ml, 4]], xp: 30000 })
      const blockedByOwner = await person({ skills: [[ml, 5]] })
      const blockedOwner = await person({ skills: [[ml, 5]] })
      const paused = await person({ skills: [[ml, 5]], paused: true })
      const gone = await person({ skills: [[ml, 5]], deleted: true })
      const young = await person({ skills: [[ml, 5]], ageDays: 2 })
      const unverified = await person({ skills: [[ml, 5]], emailVerified: false })
      const dormant = await person({ skills: [[ml, 5]], lastActiveDaysAgo: 90 })
      const wrongType = await person({ skills: [[ml, 5]], types: ['MENTOR'] })
      const datingOnly = await person({ skills: [[ml, 5]], types: ['DATING'], birthDate: bornYearsAgo(30), phone: true })
      const passed = await person({ skills: [[ml, 5]] })
      const endedMatch = await person({ skills: [[ml, 5]] })
      const applicant = await person({ skills: [[ml, 5]] })
      const member = await person({ skills: [[ml, 5]] })
      await testPrisma.block.create({ data: { blockerId: owner.userId, blockedId: blockedByOwner.id } })
      await testPrisma.block.create({ data: { blockerId: blockedOwner.id, blockedId: owner.userId } })
      await testPrisma.drop.create({ data: { userId: owner.userId, candidateId: passed.id, connectionType: 'COLLABORATOR', score: 50, localDate: '2026-01-01', status: 'PASSED', expiresAt: daysAgo(1), createdAt: daysAgo(40), updatedAt: daysAgo(10) } })
      const [a, b] = owner.userId < endedMatch.id ? [owner.userId, endedMatch.id] : [endedMatch.id, owner.userId]
      await testPrisma.match.create({ data: { userAId: a, userBId: b, userARole: 'COLLABORATOR', userBRole: 'COLLABORATOR', connectionType: 'COLLABORATOR', endedAt: new Date(), endReason: 'UNMATCHED' } })
      await testPrisma.teamApplication.create({ data: { userId: applicant.id, teamId } })
      await testPrisma.teamMember.create({ data: { userId: member.id, teamId, role: 'MEMBER' } })

      const res = await gaps(owner)
      const shown = new Set(ids(res))
      expect(shown.has(control.id)).toBe(true)
      for (const out of [blockedByOwner, blockedOwner, paused, gone, young, unverified, dormant, wrongType, datingOnly, passed, endedMatch, applicant, member, { id: owner.userId }, { id: teamAdmin.userId }, { id: plainMember.userId }]) {
        expect(shown.has(out.id), JSON.stringify(out)).toBe(false)
      }
    })

    it('keeps people the owner has been shown lately, sparked or matched with: that is a reason to invite them, not to hide them', async () => {
      const friend = await person({ skills: [[ml, 5]], xp: 90000 })
      const [a, b] = owner.userId < friend.id ? [owner.userId, friend.id] : [friend.id, owner.userId]
      await testPrisma.match.create({ data: { userAId: a, userBId: b, userARole: 'COLLABORATOR', userBRole: 'COLLABORATOR', connectionType: 'COLLABORATOR' } })
      await testPrisma.drop.create({ data: { userId: owner.userId, candidateId: friend.id, connectionType: 'COLLABORATOR', score: 80, localDate: '2026-01-02', status: 'EXPIRED', expiresAt: daysAgo(1) } })
      expect(ids(await gaps(owner))).toContain(friend.id)
    })

    it('never mixes dating in: a person who chose dating and something else is a candidate for the something else only', async () => {
      const both = await person({ skills: [[ml, 5]], types: ['COLLABORATOR', 'DATING'], birthDate: bornYearsAgo(30), phone: true, xp: 80000 })
      const res = await gaps(owner)
      const mine = res.data.candidates.find((c: { person: { id: string } }) => c.person.id === both.id)
      expect(mine?.connectionType).toBe('COLLABORATOR')
      for (const c of res.data.candidates) expect(c.connectionType).not.toBe('DATING')
    })

    it('looks for hackathon teammates when the team is for a hackathon', async () => {
      const hackathon = await testPrisma.hackathon.create({
        data: { name: `Gap Hack ${suffix}`, slug: `gap-hack-${suffix}`, description: 'x', startDate: new Date(Date.now() + 5 * DAY_MS), endDate: new Date(Date.now() + 7 * DAY_MS) },
      })
      await testPrisma.hackathonParticipant.create({ data: { userId: owner.userId, hackathonId: hackathon.id } })
      const hackTeam = await req(owner.jar, 'POST', '/api/teams', { name: `Gap Hack Crew ${suffix}`, hackathonId: hackathon.id, lookingFor: [ml] })
      expect(hackTeam.status, JSON.stringify(hackTeam.data)).toBe(201)
      const teammate = await person({ skills: [[ml, 5]], types: ['HACKATHON_TEAMMATE'], xp: 70000 })
      const collaborator = await person({ skills: [[ml, 5]], types: ['COLLABORATOR'], xp: 70000 })
      const res = await gaps(owner, hackTeam.data.id)
      expect(res.status).toBe(200)
      expect(ids(res)).toContain(teammate.id)
      expect(ids(res)).not.toContain(collaborator.id)
      for (const c of res.data.candidates) expect(c.connectionType).toBe('HACKATHON_TEAMMATE')
      await testPrisma.team.deleteMany({ where: { id: hackTeam.data.id } })
      await testPrisma.hackathon.delete({ where: { id: hackathon.id } })
    })

    it('answers for a team that asked for nothing: no gaps, and no candidates to rank against', async () => {
      const bare = await req(owner.jar, 'POST', '/api/teams', { name: `Bare Crew ${suffix}` })
      const res = await gaps(owner, bare.data.id)
      expect(res.status).toBe(200)
      expect(res.data.missing).toEqual({ skills: [], roles: [] })
      expect(res.data.covered).toEqual({ skills: [], roles: [] })
      expect(res.data.needs).toEqual({ team: [], project: [], stack: [] })
      expect(Array.isArray(res.data.candidates)).toBe(true)
      await testPrisma.team.deleteMany({ where: { id: bare.data.id } })
    })

    it('invites through the existing flow', async () => {
      const candidate = (await gaps(owner)).data.candidates[0].person.id
      const invitation = await req(owner.jar, 'POST', `/api/teams/${teamId}/invitations`, { userId: candidate })
      expect(invitation.status).toBe(201)
      // Once invited they are an applicant, and leave the suggestions.
      expect(ids(await gaps(owner))).not.toContain(candidate)
    })
  })
})
