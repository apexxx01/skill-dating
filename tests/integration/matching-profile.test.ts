import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { tombstoneClerkUser } from '../../src/lib/user-sync'

const DAY_MS = 24 * 60 * 60 * 1000

/** A date of birth that makes someone exactly `years` old today (UTC) plus `extraDays` days (negative: younger). */
function bornYearsAgo(years: number, extraDays = 0): string {
  const now = new Date()
  const date = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
  return new Date(date.getTime() - extraDays * DAY_MS).toISOString().slice(0, 10)
}

describe('matching profile', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let skillSlugs: string[] = []
  let hackathonId = ''
  afterAll(async () => {
    await testPrisma.hackathon.deleteMany({ where: { id: hackathonId } })
    await testPrisma.skill.deleteMany({ where: { slug: { in: skillSlugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  beforeAll(async () => {
    skillSlugs = [`mp-ml-${suffix}`, `mp-react-${suffix}`]
    for (const slug of skillSlugs) await testPrisma.skill.create({ data: { name: slug, slug, category: 'Test' } })
    const hackathon = await testPrisma.hackathon.create({
      data: { name: `MP Hack ${suffix}`, slug: `mp-hack-${suffix}`, description: 'x', startDate: new Date(Date.now() + 5 * DAY_MS), endDate: new Date(Date.now() + 7 * DAY_MS), registrationDeadline: new Date(Date.now() + 4 * DAY_MS) },
    })
    hackathonId = hackathon.id
  })

  const user = async (over: { birthDate?: string | null; verified?: boolean; phone?: boolean; github?: boolean } = {}): Promise<TestUser> => {
    const name = `mp${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    await testPrisma.user.update({
      where: { id: u.userId },
      data: {
        isEmailVerified: over.verified ?? true,
        isPhoneVerified: over.phone ?? false,
        githubConnected: over.github ?? false,
        birthDate: over.birthDate ? new Date(`${over.birthDate}T00:00:00Z`) : null,
      },
    })
    return u
  }
  const get = (u: TestUser | null) => req(u?.jar ?? null, 'GET', '/api/matching/profile')
  const put = (u: TestUser | null, body: unknown) => req(u?.jar ?? null, 'PUT', '/api/matching/profile', body)

  describe('authentication', () => {
    it('needs a signed-in user for the profile and the quiz', async () => {
      expect((await get(null)).status).toBe(401)
      expect((await put(null, { connectionTypes: ['COFOUNDER'] })).status).toBe(401)
      expect((await req(null, 'GET', '/api/matching/quiz')).status).toBe(401)
    })
  })

  describe('GET /api/matching/quiz', () => {
    it('serves the fixed questions with ordered options', async () => {
      const u = await user()
      const res = await req(u.jar, 'GET', '/api/matching/quiz')
      expect(res.status).toBe(200)
      expect(res.data.version).toBe(1)
      expect(res.data.questions.map((q: { id: string }) => q.id)).toEqual(['pace', 'communication', 'planning', 'decisions', 'rhythm', 'risk'])
      for (const question of res.data.questions) {
        expect(question.prompt).toEqual(expect.any(String))
        for (const option of question.options) expect(Object.keys(option).sort()).toEqual(['id', 'label'])
      }
    })
  })

  describe('GET and PUT /api/matching/profile', () => {
    it('answers with defaults before anything was saved, and a read creates nothing', async () => {
      const u = await user()
      const res = await get(u)
      expect(res.status).toBe(200)
      expect(res.data.exists).toBe(false)
      expect(res.data.profile).toEqual({
        connectionTypes: [],
        intentTags: [],
        hoursPerWeek: null,
        availableFrom: null,
        remoteOk: true,
        cityOnly: false,
        lookingForSkills: [],
        workingStyle: {},
        dropTimeLocal: '09:00',
        paused: false,
      })
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(0)
    })

    it('saves the whole profile and reads it back', async () => {
      const u = await user()
      const body = {
        connectionTypes: ['COFOUNDER', 'MENTEE'],
        intentTags: [{ tag: 'ship-mvp-90-days' }, { tag: 'win-a-hackathon', hackathonId, expiresAt: new Date(Date.now() + 20 * DAY_MS).toISOString() }],
        hoursPerWeek: 20,
        availableFrom: '2026-12-01',
        remoteOk: false,
        cityOnly: true,
        lookingForSkills: skillSlugs,
        workingStyle: { pace: 'steady', rhythm: 'night' },
        dropTimeLocal: '07:30',
        paused: false,
      }
      const saved = await put(u, body)
      expect(saved.status).toBe(200)
      expect(saved.data.exists).toBe(true)
      expect(saved.data.profile).toMatchObject({ ...body, intentTags: [body.intentTags[0], expect.objectContaining({ tag: 'win-a-hackathon', hackathonId })] })
      expect((await get(u)).data).toEqual(saved.data)
      expect(await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: u.userId } })).toMatchObject({ connectionTypes: ['COFOUNDER', 'MENTEE'], hoursPerWeek: 20, dropTimeLocal: '07:30', lastDropDate: null })
    })

    it('replaces the profile: what is left out goes back to its default', async () => {
      const u = await user()
      await put(u, { connectionTypes: ['COFOUNDER'], hoursPerWeek: 10, paused: true, lookingForSkills: [skillSlugs[0]] })
      const second = await put(u, { connectionTypes: ['COLLABORATOR'] })
      expect(second.data.profile).toMatchObject({ connectionTypes: ['COLLABORATOR'], hoursPerWeek: null, paused: false, lookingForSkills: [] })
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(1)
    })

    it('keeps one profile per user and never shows or changes another user’s', async () => {
      const a = await user()
      const b = await user()
      await put(a, { connectionTypes: ['MENTOR'], hoursPerWeek: 5 })
      expect((await get(b)).data.exists).toBe(false)
      await put(b, { connectionTypes: ['COFOUNDER'] })
      expect((await get(a)).data.profile).toMatchObject({ connectionTypes: ['MENTOR'], hoursPerWeek: 5 })
    })

    it('does not let a request set the fields the system owns', async () => {
      const u = await user()
      for (const extra of [{ lastDropDate: '2026-10-16' }, { userId: 'someone-else' }, { id: 'x' }, { createdAt: '2020-01-01T00:00:00Z' }]) {
        const res = await put(u, { connectionTypes: ['COFOUNDER'], ...extra })
        expect(res.status, JSON.stringify(extra)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(0)
    })

    it('validates the body and saves nothing when it is wrong', async () => {
      const u = await user()
      const bad: unknown[] = [
        {},
        { connectionTypes: [] },
        { connectionTypes: ['FRIEND'] },
        { connectionTypes: ['COFOUNDER', 'COFOUNDER'] },
        { connectionTypes: ['COFOUNDER'], hoursPerWeek: 0 },
        { connectionTypes: ['COFOUNDER'], hoursPerWeek: 500 },
        { connectionTypes: ['COFOUNDER'], availableFrom: '2026-02-30' },
        { connectionTypes: ['COFOUNDER'], dropTimeLocal: '25:00' },
        { connectionTypes: ['COFOUNDER'], workingStyle: { pace: 'warp-speed' } },
        { connectionTypes: ['COFOUNDER'], workingStyle: { unknown: 'steady' } },
        { connectionTypes: ['COFOUNDER'], intentTags: [{ tag: 'NOT A TAG' }] },
        { connectionTypes: ['COFOUNDER'], intentTags: Array.from({ length: 11 }, (_, i) => ({ tag: `tag-${i}` })) },
        { connectionTypes: ['COFOUNDER'], remoteOk: 'yes' },
        'not an object',
      ]
      for (const body of bad) {
        const res = await put(u, body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
      expect((await req(u.jar, 'PUT', '/api/matching/profile', 'nope' as unknown as object)).status).toBe(400)
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(0)
    })

    it('refuses a skill or a hackathon that does not exist, and a tag that has expired or lasts over a year', async () => {
      const u = await user()
      const unknownSkill = await put(u, { connectionTypes: ['COFOUNDER'], lookingForSkills: [skillSlugs[0], 'no-such-skill'] })
      expect(unknownSkill.status).toBe(400)
      expect(unknownSkill.data.error.details.lookingForSkills).toEqual(['Unknown skill: no-such-skill'])
      const unknownHackathon = await put(u, { connectionTypes: ['COFOUNDER'], intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'does-not-exist' }] })
      expect(unknownHackathon.data.error.details.intentTags).toEqual(['Unknown hackathon: does-not-exist'])
      const expired = await put(u, { connectionTypes: ['COFOUNDER'], intentTags: [{ tag: 'old-tag', expiresAt: new Date(Date.now() - DAY_MS).toISOString() }] })
      expect(expired.data.error.details.intentTags).toEqual(['old-tag has already expired'])
      const far = await put(u, { connectionTypes: ['COFOUNDER'], intentTags: [{ tag: 'far-tag', expiresAt: new Date(Date.now() + 400 * DAY_MS).toISOString() }] })
      expect(far.data.error.details.intentTags).toEqual(['far-tag expires more than a year from now'])
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(0)
    })
  })

  describe('DATING: opt-in, verified, and 18 or older', () => {
    const dating = { connectionTypes: ['DATING'] }

    it('is refused without a date of birth, however well verified the account is', async () => {
      const u = await user({ birthDate: null, phone: true, github: true })
      const res = await put(u, dating)
      expect(res.status).toBe(403)
      expect(res.data.error.code).toBe('DATING_BIRTH_DATE_REQUIRED')
      expect(res.data.error.details.blockers).toContain('BIRTH_DATE_MISSING')
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(0)
    })

    it('is refused to anyone under 18, to the day', async () => {
      const dayShort = await user({ birthDate: bornYearsAgo(18, -1), phone: true })
      const res = await put(dayShort, dating)
      expect(res.status).toBe(403)
      expect(res.data.error.code).toBe('DATING_UNDERAGE')
      const child = await user({ birthDate: bornYearsAgo(12), phone: true, github: true })
      expect((await put(child, dating)).data.error.code).toBe('DATING_UNDERAGE')
      const newborn = await user({ birthDate: bornYearsAgo(0), phone: true })
      expect((await put(newborn, dating)).status).toBe(403)
      for (const refused of [dayShort, child, newborn]) expect(await testPrisma.matchingProfile.count({ where: { userId: refused.userId } })).toBe(0)
    })

    it('is allowed from the day someone turns 18', async () => {
      const adult = await user({ birthDate: bornYearsAgo(18), phone: true })
      const res = await put(adult, dating)
      expect(res.status).toBe(200)
      expect(res.data.profile.connectionTypes).toEqual(['DATING'])
      expect(res.data.dating).toEqual({ eligible: true, blockers: [], minAge: 18 })
    })

    it('needs a verified email', async () => {
      const u = await user({ birthDate: bornYearsAgo(30), verified: false, phone: true })
      const res = await put(u, dating)
      expect(res.status).toBe(403)
      expect(res.data.error.code).toBe('DATING_VERIFICATION_REQUIRED')
    })

    it('needs a verified phone or a connected GitHub account, and either is enough', async () => {
      const neither = await user({ birthDate: bornYearsAgo(30) })
      const refused = await put(neither, dating)
      expect(refused.status).toBe(403)
      expect(refused.data.error.code).toBe('DATING_VERIFICATION_REQUIRED')
      expect(refused.data.error.details.blockers).toEqual(['NO_PHONE_OR_GITHUB'])
      expect((await put(await user({ birthDate: bornYearsAgo(30), phone: true }), dating)).status).toBe(200)
      expect((await put(await user({ birthDate: bornYearsAgo(30), github: true }), dating)).status).toBe(200)
    })

    it('is checked when DATING is one of several types, and not when it is not asked for', async () => {
      const minor = await user({ birthDate: bornYearsAgo(16), phone: true })
      expect((await put(minor, { connectionTypes: ['COFOUNDER', 'DATING'] })).status).toBe(403)
      expect((await put(minor, { connectionTypes: ['COFOUNDER', 'MENTEE'] })).status).toBe(200)
    })

    it('tells the owner what is missing, on the profile read', async () => {
      const u = await user({ birthDate: null })
      expect((await get(u)).data.dating).toEqual({ eligible: false, blockers: ['BIRTH_DATE_MISSING', 'NO_PHONE_OR_GITHUB'], minAge: 18 })
      const fixed = await user({ birthDate: bornYearsAgo(25), phone: true })
      expect((await get(fixed)).data.dating.eligible).toBe(true)
    })

    it('lets someone who lost eligibility take DATING off, and not put it back until they are eligible again', async () => {
      const u = await user({ birthDate: bornYearsAgo(30), phone: true })
      expect((await put(u, { connectionTypes: ['DATING', 'COFOUNDER'] })).status).toBe(200)
      await testPrisma.user.update({ where: { id: u.userId }, data: { isPhoneVerified: false } })
      expect((await get(u)).data.dating.eligible).toBe(false)
      expect((await put(u, { connectionTypes: ['DATING', 'COFOUNDER'], hoursPerWeek: 5 })).status).toBe(403)
      expect((await put(u, { connectionTypes: ['COFOUNDER'] })).status).toBe(200)
    })
  })

  describe('the date of birth is private', () => {
    const born = '1991-03-27'

    it('is set once through the profile settings, and only the owner’s own read returns it', async () => {
      const u = await user()
      expect((await req(u.jar, 'GET', '/api/users/me/profile')).data.birthDate).toBeNull()
      const set = await req(u.jar, 'PATCH', '/api/users/me/profile', { birthDate: born })
      expect(set.status).toBe(200)
      expect(set.data.birthDate).toBe(born)
      expect((await req(u.jar, 'GET', '/api/users/me/profile')).data.birthDate).toBe(born)
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })).birthDate?.toISOString().slice(0, 10)).toBe(born)
    })

    it('is locked once set: a different date is refused, the same one is fine, and it cannot be cleared', async () => {
      const u = await user({ birthDate: born })
      const change = await req(u.jar, 'PATCH', '/api/users/me/profile', { birthDate: '2000-01-01' })
      expect(change.status).toBe(409)
      expect(change.data.error.code).toBe('BIRTH_DATE_LOCKED')
      expect((await req(u.jar, 'PATCH', '/api/users/me/profile', { birthDate: born })).status).toBe(200)
      expect((await req(u.jar, 'PATCH', '/api/users/me/profile', { birthDate: null })).status).toBe(400)
      expect((await req(u.jar, 'GET', '/api/users/me/profile')).data.birthDate).toBe(born)
    })

    it('is how a minor stays a minor: they cannot change it to pass for an adult', async () => {
      const minor = await user({ birthDate: bornYearsAgo(15), phone: true })
      expect((await req(minor.jar, 'PATCH', '/api/users/me/profile', { birthDate: bornYearsAgo(30) })).status).toBe(409)
      expect((await put(minor, { connectionTypes: ['DATING'] })).data.error.code).toBe('DATING_UNDERAGE')
    })

    it('refuses what is not a real date in the past', async () => {
      const u = await user()
      for (const bad of ['', 'tomorrow', '1991-3-27', '1991-02-30', '2999-01-01', '1800-01-01', 19910327, true]) {
        const res = await req(u.jar, 'PATCH', '/api/users/me/profile', { birthDate: bad })
        expect(res.status, JSON.stringify(bad)).toBe(400)
      }
      expect((await req(u.jar, 'GET', '/api/users/me/profile')).data.birthDate).toBeNull()
    })

    it('appears in no response another person can get', async () => {
      const owner = await user({ birthDate: born, phone: true })
      await put(owner, { connectionTypes: ['COFOUNDER'] })
      const viewer = await user()
      const team = await req(owner.jar, 'POST', '/api/teams', { name: `Privacy Crew ${suffix}`, description: 'x' })
      const surfaces: [string, string][] = [
        ['GET', `/api/users/${owner.userId}`],
        ['GET', `/api/users/${owner.userId}/stats`],
        ['GET', `/api/users/${owner.userId}/achievements`],
        ['GET', `/api/users/${owner.userId}/heatmap`],
        ['GET', `/api/users?limit=50`],
        ['GET', `/api/discover?limit=50`],
        ['GET', '/api/dashboard'],
        ['GET', '/api/leaderboard'],
        ['GET', '/api/users/me'],
      ]
      if (team.status === 201) surfaces.push(['GET', `/api/teams/${team.data.id}`], ['GET', '/api/teams'])
      for (const [method, path] of surfaces) {
        const res = await req(viewer.jar, method, path)
        const text = JSON.stringify(res.data)
        expect(text, `${method} ${path}`).not.toContain(born)
        expect(text.toLowerCase(), `${method} ${path}`).not.toContain('birthdate')
      }
      // And the owner’s other reads do not carry it either; only their profile settings do.
      for (const path of [`/api/users/${owner.userId}`, '/api/users/me', '/api/matching/profile', `/api/users/${owner.userId}/stats`]) {
        const text = JSON.stringify((await req(owner.jar, 'GET', path)).data)
        expect(text, path).not.toContain(born)
      }
    })

    it('is wiped, with the matching profile, when the account is deleted', async () => {
      const u = await user({ birthDate: born, phone: true })
      await put(u, { connectionTypes: ['COFOUNDER'] })
      const row = await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId }, select: { clerkId: true } })
      expect(row.clerkId).not.toBeNull()
      expect(await tombstoneClerkUser(row.clerkId!, testPrisma)).toBe(true)
      const after = await testPrisma.user.findUniqueOrThrow({ where: { id: u.userId } })
      expect(after.birthDate).toBeNull()
      expect(after.deletedAt).not.toBeNull()
      expect(await testPrisma.matchingProfile.count({ where: { userId: u.userId } })).toBe(0)
    })
  })
})
