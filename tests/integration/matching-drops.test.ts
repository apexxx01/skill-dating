import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, daysAgo, makePerson, makeSkills, removePeople, type FixtureOptions } from './matching-fixtures'
import { dueUserIds, expireDrops, generateDropsForUser, runDropGeneration } from '../../src/lib/matching/drops'
import { DROP_CONFIG } from '../../src/lib/matching/config'
import { localDateKey } from '../../src/lib/time'

const DAY_MS = 24 * 60 * 60 * 1000

describe('daily drops', () => {
  const suffix = uniqueSuffix()
  const tag = `dr${suffix}`
  let slugs: string[] = []
  let ml = ''
  let react = ''
  let go = ''

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    slugs = await makeSkills(tag, ['ml', 'react', 'go'])
    ;[ml, react, go] = slugs
  })
  afterAll(async () => {
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { in: slugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  const person = (options: Partial<FixtureOptions> = {}) => makePerson({ tag, ...options })
  const now = () => new Date()
  const generate = (id: string, over: { enforced?: boolean; at?: Date; force?: boolean } = {}) =>
    generateDropsForUser(testPrisma, id, over.at ?? now(), { enforced: over.enforced ?? false, force: over.force })
  const dropsOf = (userId: string) => testPrisma.drop.findMany({ where: { userId }, orderBy: [{ score: 'desc' }, { id: 'asc' }] })
  const shown = async (userId: string) => (await dropsOf(userId)).map((drop) => drop.candidateId)

  describe('who is shown, and how many', () => {
    it('gives the best-fitting people, best first, with the lines that explain the score', async () => {
      const viewer = await person({ lookingForSkills: [ml], skills: [[react, 4]] })
      const strong = await person({ skills: [[ml, 5], [react, 3]], lookingForSkills: [react] })
      const weak = await person({ skills: [[ml, 1]] })
      await testPrisma.skillEvidence.create({ data: { userId: strong.id, skillId: (await testPrisma.skill.findUniqueOrThrow({ where: { slug: ml } })).id, type: 'GITHUB_PROJECT', title: 'ML repo', verifiedAt: new Date() } })

      const result = await generate(viewer.id)
      expect(result.created).toBeGreaterThanOrEqual(2)
      const drops = await dropsOf(viewer.id)
      const ranked = drops.map((d) => d.candidateId)
      // Everybody who is also looking for ML is in the pool; what is fixed is the order between these two, and that the best fit leads.
      expect(ranked.indexOf(strong.id)).toBeGreaterThanOrEqual(0)
      expect(ranked.indexOf(strong.id)).toBeLessThan(ranked.indexOf(weak.id))
      expect(drops[0].score).toBeGreaterThanOrEqual(drops[1].score)
      expect(drops.find((d) => d.candidateId === strong.id)!.score).toBeGreaterThan(drops.find((d) => d.candidateId === weak.id)!.score)
      const top = drops.find((d) => d.candidateId === strong.id)!
      expect(top.connectionType).toBe('COFOUNDER')
      expect(top.status).toBe('NEW')
      expect(top.secondLook).toBe(false)
      const reasons = top.reasons as string[]
      expect(reasons.length).toBeGreaterThan(0)
      expect(reasons.length).toBeLessThanOrEqual(3)
      expect(reasons[0]).toBe(`You need ${ml}, they have 1 verified ${ml} project`)
      expect(top.localDate).toBe(localDateKey(now(), null))
      expect(top.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('gives as many as the plan allows: 3 on the free plan, the best 3', async () => {
      const viewer = await person({ lookingForSkills: [ml] })
      const people = []
      for (let i = 0; i < 6; i++) people.push(await person({ skills: [[ml, i + 1]] }))
      const result = await generate(viewer.id, { enforced: true })
      expect(result.created).toBe(3)
      const chosen = await shown(viewer.id)
      // The three with the highest ML level are the best fit.
      expect(new Set(chosen)).toEqual(new Set([people[5].id, people[4].id, people[3].id]))
    })

    it('gives a paid plan more, and counts what a person already has today against the allowance', async () => {
      const viewer = await person({ lookingForSkills: [ml] })
      for (let i = 0; i < 12; i++) await person({ skills: [[ml, 3]] })
      await testPrisma.subscription.create({ data: { userId: viewer.id, plan: 'PRO', status: 'ACTIVE' } })
      expect((await generate(viewer.id, { enforced: true })).created).toBe(10)
      // Asking again the same day (forced) adds nothing: the allowance is used.
      expect((await generate(viewer.id, { enforced: true, force: true })).created).toBe(0)
      expect(await testPrisma.drop.count({ where: { userId: viewer.id } })).toBe(10)
    })

    it('generates a day once: the second run finds the marker', async () => {
      const viewer = await person({ lookingForSkills: [ml] })
      await person({ skills: [[ml, 3]] })
      expect((await generate(viewer.id)).created).toBeGreaterThanOrEqual(1)
      const again = await generate(viewer.id)
      expect(again).toMatchObject({ created: 0, skipped: 'ALREADY_GENERATED' })
      expect((await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: viewer.id } })).lastDropDate).toBe(localDateKey(now(), null))
    })

    it('marks the day done even when nobody fits, so it is not tried again every hour', async () => {
      const lonely = await person({ types: ['MENTEE'] })
      expect(await generate(lonely.id)).toMatchObject({ created: 0 })
      expect((await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: lonely.id } })).lastDropDate).not.toBeNull()
    })

    it('does nothing for a person with no profile, a paused one or a deleted one', async () => {
      const none = await person({ profile: false })
      const paused = await person({ paused: true })
      const gone = await person({ deleted: true })
      expect(await generate(none.id)).toMatchObject({ created: 0, skipped: 'NO_PROFILE' })
      expect(await generate(paused.id)).toMatchObject({ created: 0, skipped: 'PAUSED' })
      expect(await generate(gone.id)).toMatchObject({ created: 0, skipped: 'GONE' })
      expect(await generate('no-such-user')).toMatchObject({ skipped: 'GONE' })
    })
  })

  describe('who is left out', () => {
    it('leaves out everybody who must not be shown, and still shows a control who fits', async () => {
      const viewer = await person({ lookingForSkills: [ml] })
      const control = await person({ skills: [[ml, 5]] })
      const blockedByMe = await person({ skills: [[ml, 5]] })
      const blockedMe = await person({ skills: [[ml, 5]] })
      const paused = await person({ skills: [[ml, 5]], paused: true })
      const deleted = await person({ skills: [[ml, 5]], deleted: true })
      const young = await person({ skills: [[ml, 5]], ageDays: 3 })
      const unverified = await person({ skills: [[ml, 5]], emailVerified: false })
      const dormant = await person({ skills: [[ml, 5]], lastActiveDaysAgo: 90 })
      const wrongType = await person({ skills: [[ml, 5]], types: ['COLLABORATOR'] })
      const noProfile = await person({ skills: [[ml, 5]], profile: false })
      const passedRecently = await person({ skills: [[ml, 5]] })
      const shownLately = await person({ skills: [[ml, 5]] })
      const passedLongAgo = await person({ skills: [[ml, 5]] })
      await testPrisma.block.create({ data: { blockerId: viewer.id, blockedId: blockedByMe.id } })
      await testPrisma.block.create({ data: { blockerId: blockedMe.id, blockedId: viewer.id } })
      const old = (candidateId: string, over: Record<string, unknown>) =>
        testPrisma.drop.create({ data: { userId: viewer.id, candidateId, connectionType: 'COFOUNDER', score: 50, localDate: '2026-01-01', expiresAt: daysAgo(1), ...over } })
      await old(passedRecently.id, { status: 'PASSED', createdAt: daysAgo(40), updatedAt: daysAgo(10) })
      await old(shownLately.id, { status: 'EXPIRED', createdAt: daysAgo(3), updatedAt: daysAgo(2) })
      await old(passedLongAgo.id, { status: 'PASSED', createdAt: daysAgo(60), updatedAt: daysAgo(45) })

      await generate(viewer.id)
      const chosen = new Set(await shown(viewer.id))
      // Only the drops written by the run itself count: the three set-up rows are from other days.
      const today = new Set((await testPrisma.drop.findMany({ where: { userId: viewer.id, localDate: localDateKey(now(), null) } })).map((d) => d.candidateId))
      expect(today.has(control.id)).toBe(true)
      expect(today.has(passedLongAgo.id)).toBe(true) // a pass older than 30 days no longer counts
      for (const out of [blockedByMe, blockedMe, paused, deleted, young, unverified, dormant, wrongType, noProfile, passedRecently, shownLately, { id: viewer.id }]) {
        expect(today.has(out.id), `${JSON.stringify(out)}`).toBe(false)
      }
      expect(chosen.size).toBeGreaterThan(0)
    })

    it('holds a candidate to the daily exposure cap: popular people are not shown to everyone', async () => {
      const popular = await person({ skills: [[ml, 5]] })
      const viewers = []
      for (let i = 0; i < DROP_CONFIG.exposureCapPerDay + 5; i++) viewers.push(await person({ lookingForSkills: [ml] }))
      // A filler or two so every viewer has someone else to be shown.
      await person({ skills: [[ml, 1]] })
      for (const viewer of viewers) await generate(viewer.id)
      const exposures = await testPrisma.drop.count({ where: { candidateId: popular.id, createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) } } })
      expect(exposures).toBe(DROP_CONFIG.exposureCapPerDay)
    })

    it('respects "only my city" from either side', async () => {
      const viewer = await person({ lookingForSkills: [ml], cityOnly: true, cityKey: `pune-${suffix}` })
      const sameCity = await person({ skills: [[ml, 3]], cityKey: `pune-${suffix}` })
      const elsewhere = await person({ skills: [[ml, 5]], cityKey: `berlin-${suffix}` })
      const noCity = await person({ skills: [[ml, 5]] })
      const wantsOtherCity = await person({ skills: [[ml, 5]], cityKey: `pune-${suffix}`, cityOnly: true })
      await generate(viewer.id)
      const chosen = new Set(await shown(viewer.id))
      expect(chosen.has(sameCity.id)).toBe(true)
      expect(chosen.has(wantsOtherCity.id)).toBe(true)
      expect(chosen.has(elsewhere.id)).toBe(false)
      expect(chosen.has(noCity.id)).toBe(false)

      const free = await person({ lookingForSkills: [ml], cityKey: `pune-${suffix}` })
      const strict = await person({ skills: [[ml, 5]], cityOnly: true, cityKey: `berlin-${suffix}` })
      await generate(free.id)
      expect((await shown(free.id)).includes(strict.id)).toBe(false)
    })
  })

  describe('one at a time per type', () => {
    it('gives at most one drop per type to somebody who chose several', async () => {
      const viewer = await person({ types: ['COFOUNDER', 'COLLABORATOR', 'MENTEE'], lookingForSkills: [ml] })
      for (let i = 0; i < 4; i++) await person({ types: ['COFOUNDER'], skills: [[ml, 3 + (i % 2)]] })
      for (let i = 0; i < 4; i++) await person({ types: ['COLLABORATOR'], skills: [[ml, 3]] })
      for (let i = 0; i < 4; i++) await person({ types: ['MENTOR'], skills: [[ml, 5]] })
      await generate(viewer.id)
      const drops = await dropsOf(viewer.id)
      const perType = new Map<string, number>()
      for (const drop of drops) perType.set(drop.connectionType, (perType.get(drop.connectionType) ?? 0) + 1)
      expect([...perType.values()].every((count) => count === 1)).toBe(true)
      expect([...perType.keys()].sort()).toEqual(['COFOUNDER', 'COLLABORATOR', 'MENTEE'])
      expect(new Set(drops.map((d) => d.candidateId)).size).toBe(drops.length)
    })

    it('pairs mentees with mentors, and shows a mentor the mentees', async () => {
      const mentee = await person({ types: ['MENTEE'] })
      const mentor = await person({ types: ['MENTOR'], skills: [[ml, 5]] })
      const peer = await person({ types: ['MENTEE'] })
      await generate(mentee.id)
      const menteeDrops = await dropsOf(mentee.id)
      expect(menteeDrops.map((d) => d.candidateId)).toContain(mentor.id)
      expect(menteeDrops.map((d) => d.candidateId)).not.toContain(peer.id)
      expect(menteeDrops.find((d) => d.candidateId === mentor.id)?.connectionType).toBe('MENTEE')
      await generate(mentor.id)
      const mentorDrops = await dropsOf(mentor.id)
      expect(mentorDrops.map((d) => d.candidateId)).toContain(mentee.id)
      expect(mentorDrops.find((d) => d.candidateId === mentee.id)?.connectionType).toBe('MENTOR')
    })

    it('gives somebody who chose only one type as many as the allowance', async () => {
      const viewer = await person({ types: ['COLLABORATOR'], lookingForSkills: [ml] })
      const mine = []
      for (let i = 0; i < 5; i++) mine.push(await person({ types: ['COLLABORATOR'], skills: [[ml, 3]] }))
      expect((await generate(viewer.id)).created).toBeGreaterThanOrEqual(5)
      const chosen = await shown(viewer.id)
      for (const candidate of mine) expect(chosen).toContain(candidate.id)
    })
  })

  describe('dating is its own world', () => {
    const adult = bornYearsAgo(30)

    it('shows DATING only to eligible people, from eligible people who chose DATING', async () => {
      const viewer = await person({ types: ['DATING'], birthDate: adult, phone: true })
      const ok = await person({ types: ['DATING'], birthDate: adult, github: true })
      const minor = await person({ types: ['DATING'], birthDate: bornYearsAgo(17), phone: true })
      const justTurned = await person({ types: ['DATING'], birthDate: bornYearsAgo(18), phone: true })
      const dayShort = await person({ types: ['DATING'], birthDate: bornYearsAgo(18, -1), phone: true })
      const noBirthDate = await person({ types: ['DATING'], birthDate: null, phone: true })
      const noPhoneOrGithub = await person({ types: ['DATING'], birthDate: adult })
      const unverifiedEmail = await person({ types: ['DATING'], birthDate: adult, phone: true, emailVerified: false })
      const notDating = await person({ types: ['COFOUNDER'], birthDate: adult, phone: true, skills: [[ml, 5]] })
      await generate(viewer.id)
      const chosen = new Set(await shown(viewer.id))
      expect(chosen.has(ok.id)).toBe(true)
      expect(chosen.has(justTurned.id)).toBe(true)
      for (const out of [minor, dayShort, noBirthDate, noPhoneOrGithub, unverifiedEmail, notDating]) expect(chosen.has(out.id)).toBe(false)
      for (const drop of await dropsOf(viewer.id)) expect(drop.connectionType).toBe('DATING')
    })

    it('never shows a DATING-only person in a drop of another type, and never a cofounder in a dating drop', async () => {
      const datingOnly = await person({ types: ['DATING'], birthDate: adult, phone: true, skills: [[ml, 5]], xp: 90000 })
      const cofounderOnly = await person({ types: ['COFOUNDER'], birthDate: adult, phone: true, skills: [[ml, 5]], xp: 90000 })
      const cofounderViewer = await person({ types: ['COFOUNDER'], lookingForSkills: [ml] })
      const mixedViewer = await person({ types: ['COFOUNDER', 'DATING'], birthDate: adult, phone: true, lookingForSkills: [ml] })
      await generate(cofounderViewer.id)
      expect(await shown(cofounderViewer.id)).not.toContain(datingOnly.id)
      await generate(mixedViewer.id)
      const drops = await dropsOf(mixedViewer.id)
      for (const drop of drops) {
        if (drop.connectionType === 'DATING') expect(drop.candidateId).not.toBe(cofounderOnly.id)
        else expect(drop.candidateId).not.toBe(datingOnly.id)
      }
      expect(drops.find((d) => d.candidateId === datingOnly.id)?.connectionType).toBe('DATING')
      expect(drops.find((d) => d.candidateId === cofounderOnly.id)?.connectionType).toBe('COFOUNDER')
      expect(drops.filter((d) => d.connectionType === 'DATING')).toHaveLength(1)
    })

    it('gives a minor no dating drops even when a dating profile was written for them', async () => {
      const minor = await person({ types: ['DATING', 'COFOUNDER'], birthDate: bornYearsAgo(16), phone: true, github: true, lookingForSkills: [ml] })
      await person({ types: ['DATING'], birthDate: adult, phone: true })
      const cofounder = await person({ types: ['COFOUNDER'], skills: [[ml, 5]], xp: 90000 })
      await generate(minor.id)
      const drops = await dropsOf(minor.id)
      expect(drops.some((d) => d.connectionType === 'DATING')).toBe(false)
      expect(drops.filter((d) => d.connectionType === 'COFOUNDER')).toHaveLength(1)
      expect(cofounder.id).toBeTruthy()
      const dating = await person({ types: ['DATING'], birthDate: adult, phone: true })
      const minorOnly = await person({ types: ['DATING'], birthDate: bornYearsAgo(17), github: true })
      await generate(minorOnly.id)
      expect(await dropsOf(minorOnly.id)).toEqual([])
      await generate(dating.id)
      expect(await shown(dating.id)).not.toContain(minor.id)
      expect(await shown(dating.id)).not.toContain(minorOnly.id)
    })

    it('stops showing dating to somebody who lost eligibility', async () => {
      const viewer = await person({ types: ['DATING'], birthDate: adult, phone: true })
      await person({ types: ['DATING'], birthDate: adult, phone: true })
      await testPrisma.user.update({ where: { id: viewer.id }, data: { isPhoneVerified: false, githubConnected: false } })
      expect((await generate(viewer.id)).created).toBe(0)
    })
  })

  describe('when drops are made', () => {
    it('is due once the chosen time has passed in the person’s own time zone, and not before', async () => {
      const viewer = await person({ timezone: 'Asia/Kolkata', dropTimeLocal: '09:00' })
      const before = new Date('2030-03-05T03:29:00Z') // 08:59 in Kolkata
      const after = new Date('2030-03-05T03:30:00Z') // 09:00 in Kolkata
      expect(await dueUserIds(testPrisma, before)).not.toContain(viewer.id)
      expect(await dueUserIds(testPrisma, after)).toContain(viewer.id)
      expect(await dueUserIds(testPrisma, new Date('2030-03-05T10:00:00Z'))).toContain(viewer.id) // 15:30 in Kolkata: still due later the same local day until generated
    })

    it('is due once per local day: after generating, again only on the next local day', async () => {
      const viewer = await person({ timezone: 'America/Los_Angeles', dropTimeLocal: '07:00' })
      const morning = new Date('2030-03-05T15:00:00Z') // 07:00 in Los Angeles (PST)
      expect(await dueUserIds(testPrisma, morning)).toContain(viewer.id)
      expect((await generate(viewer.id, { at: morning })).skipped).toBeUndefined()
      expect(await dueUserIds(testPrisma, new Date('2030-03-05T22:00:00Z'))).not.toContain(viewer.id)
      expect(await dueUserIds(testPrisma, new Date('2030-03-06T14:59:00Z'))).not.toContain(viewer.id)
      expect(await dueUserIds(testPrisma, new Date('2030-03-06T15:00:00Z'))).toContain(viewer.id)
      expect((await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: viewer.id } })).lastDropDate).toBe('2030-03-05')
    })

    it('uses UTC for somebody with no time zone, and never lists a paused or deleted person', async () => {
      const utc = await person({ timezone: null, dropTimeLocal: '12:00' })
      const paused = await person({ paused: true, dropTimeLocal: '00:00' })
      const gone = await person({ deleted: true, dropTimeLocal: '00:00' })
      const noon = new Date('2030-03-05T12:00:00Z')
      const due = await dueUserIds(testPrisma, noon)
      expect(due).toContain(utc.id)
      expect(due).not.toContain(paused.id)
      expect(due).not.toContain(gone.id)
      expect(await dueUserIds(testPrisma, new Date('2030-03-05T11:59:00Z'))).not.toContain(utc.id)
    })

    it('runs for everybody who is due and for nobody else', async () => {
      const dueViewer = await person({ lookingForSkills: [ml], dropTimeLocal: '00:00' })
      const notYet = await person({ lookingForSkills: [ml], dropTimeLocal: '23:59', timezone: 'Pacific/Kiritimati' })
      await person({ skills: [[ml, 4]] })
      const at = new Date()
      const result = await runDropGeneration(testPrisma, { now: at, enforced: false })
      expect(result.due).toBeGreaterThan(0)
      expect(result.generated).toBeGreaterThan(0)
      // Everybody due is processed in a shuffled order, so who got which candidates is not fixed; that this one was processed is.
      expect((await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: dueViewer.id } })).lastDropDate).toBe(localDateKey(at, null))
      // Whether Kiritimati's 23:59 has passed depends on the hour the suite runs; what must hold is that it is not generated before it.
      const marker = (await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: notYet.id } })).lastDropDate
      if (marker === null) expect(await dropsOf(notYet.id)).toEqual([])
    })

    it('can be told to generate for exactly some people', async () => {
      const a = await person({ lookingForSkills: [ml], dropTimeLocal: '23:59', lastDropDate: '2000-01-01' })
      await person({ skills: [[ml, 4]] })
      const result = await runDropGeneration(testPrisma, { userIds: [a.id, 'nobody'], enforced: false })
      expect(result.due).toBe(2)
      expect(result.generated).toBe(1)
      expect(result.skipped).toBe(1)
      expect((await dropsOf(a.id)).length).toBeGreaterThan(0)
    })

    it('two runs at once give nobody more than the allowance', async () => {
      const viewer = await person({ lookingForSkills: [ml] })
      for (let i = 0; i < 8; i++) await person({ skills: [[ml, 3]] })
      const results = await Promise.all([generate(viewer.id, { enforced: true }), generate(viewer.id, { enforced: true }), generate(viewer.id, { enforced: true })])
      expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(3)
      expect(await testPrisma.drop.count({ where: { userId: viewer.id } })).toBe(3)
    })
  })

  describe('expiry', () => {
    it('marks unanswered drops past their day as EXPIRED and leaves the answered and the current ones', async () => {
      const viewer = await person()
      const mk = (status: 'NEW' | 'SPARKED' | 'PASSED', expiresAt: Date, localDate: string) =>
        person().then((c) => testPrisma.drop.create({ data: { userId: viewer.id, candidateId: c.id, connectionType: 'COFOUNDER', score: 50, localDate, status, expiresAt } }))
      const stale = await mk('NEW', daysAgo(1), '2026-01-01')
      const current = await mk('NEW', new Date(Date.now() + DAY_MS), '2026-01-02')
      const sparked = await mk('SPARKED', daysAgo(1), '2026-01-03')
      const passed = await mk('PASSED', daysAgo(1), '2026-01-04')
      const { expired } = await expireDrops(testPrisma, now())
      expect(expired).toBeGreaterThanOrEqual(1)
      const status = async (id: string) => (await testPrisma.drop.findUniqueOrThrow({ where: { id } })).status
      expect(await status(stale.id)).toBe('EXPIRED')
      expect(await status(current.id)).toBe('NEW')
      expect(await status(sparked.id)).toBe('SPARKED')
      expect(await status(passed.id)).toBe('PASSED')
      expect((await expireDrops(testPrisma, now())).expired).toBe(0)
    })
  })

  describe('GET /api/drops/today and POST /api/drops/{id}/pass', () => {
    let me: TestUser
    let admin: TestUser
    let other: TestUser
    const candidates: { id: string }[] = []
    let httpSkill = ''

    beforeAll(async () => {
      // A skill nobody else in this file has, so exactly these three are the best fit for the caller.
      ;[httpSkill] = await makeSkills(`${tag}h`, ['x'])
      slugs.push(httpSkill)
      me = await registerAndLogin(`${tag}.me@test.dev`, `${tag}me`)
      other = await registerAndLogin(`${tag}.other@test.dev`, `${tag}other`)
      admin = await registerAndLogin(`${tag}.admin@test.dev`, `${tag}admin`)
      await promoteToAdmin(admin.userId)
      await testPrisma.matchingProfile.create({ data: { userId: me.userId, connectionTypes: ['COFOUNDER'], lookingForSkills: [httpSkill], dropTimeLocal: '00:00' } })
      await testPrisma.matchingProfile.create({ data: { userId: other.userId, connectionTypes: ['COFOUNDER'], dropTimeLocal: '00:00' } })
      for (let i = 0; i < 3; i++) candidates.push(await person({ skills: [[httpSkill, 5 - i]] }))
      expect((await generate(me.userId, { enforced: true })).created).toBe(3)
    }, 120_000)

    it('needs a signed-in user', async () => {
      expect((await req(null, 'GET', '/api/drops/today')).status).toBe(401)
      expect((await req(null, 'POST', '/api/drops/x/pass')).status).toBe(401)
    })

    it('lists today’s drops, best first, each with the person’s card and why', async () => {
      const res = await req(me.jar, 'GET', '/api/drops/today')
      expect(res.status).toBe(200)
      expect(res.data.hasProfile).toBe(true)
      expect(res.data.paused).toBe(false)
      expect(res.data.date).toBe(localDateKey(new Date(), null))
      expect(res.data.dropTimeLocal).toBe('00:00')
      expect(new Date(res.data.nextDropAt).getTime()).toBeGreaterThan(Date.now())
      const ids = res.data.drops.map((d: { candidate: { id: string } }) => d.candidate.id)
      for (const c of candidates) expect(ids).toContain(c.id)
      const scores = res.data.drops.map((d: { score: number }) => d.score)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
      const first = res.data.drops[0]
      expect(first).toMatchObject({ connectionType: 'COFOUNDER', status: 'NEW', secondLook: false })
      expect(first.reasons.length).toBeGreaterThan(0)
      expect(Object.keys(first.candidate).sort()).toEqual(['builderRole', 'headline', 'id', 'image', 'level', 'location', 'name', 'proof', 'skills', 'tier', 'username'])
      expect(JSON.stringify(res.data)).not.toMatch(/email|birthDate|@test\.dev/i)
    })

    it('counts a drop as viewed once, however often it is read', async () => {
      const before = await testPrisma.productEvent.count({ where: { userId: me.userId, name: 'drop_viewed' } })
      await req(me.jar, 'GET', '/api/drops/today')
      await req(me.jar, 'GET', '/api/drops/today')
      const after = await testPrisma.productEvent.count({ where: { userId: me.userId, name: 'drop_viewed' } })
      expect(after - before).toBe(0) // the first read in the previous test already counted them all
      const drops = await dropsOf(me.userId)
      expect(drops.every((d) => d.viewedAt !== null)).toBe(true)
      expect(await testPrisma.productEvent.count({ where: { userId: me.userId, name: 'drop_viewed' } })).toBe(drops.length)
    })

    it('has an empty list and a setup flag for somebody without a profile', async () => {
      const bare = await registerAndLogin(`${tag}.bare@test.dev`, `${tag}bare`)
      const res = await req(bare.jar, 'GET', '/api/drops/today')
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ drops: [], hasProfile: false, paused: false, nextDropAt: null })
    })

    it('hides a drop whose person has since been blocked, either way, and shows it again when unblocked', async () => {
      const target = (await dropsOf(me.userId))[0].candidateId
      await testPrisma.block.create({ data: { blockerId: target, blockedId: me.userId } })
      const hidden = await req(me.jar, 'GET', '/api/drops/today')
      expect(hidden.data.drops.map((d: { candidate: { id: string } }) => d.candidate.id)).not.toContain(target)
      await testPrisma.block.deleteMany({ where: { blockerId: target } })
      await testPrisma.block.create({ data: { blockerId: me.userId, blockedId: target } })
      expect((await req(me.jar, 'GET', '/api/drops/today')).data.drops.map((d: { candidate: { id: string } }) => d.candidate.id)).not.toContain(target)
      await testPrisma.block.deleteMany({ where: { blockerId: me.userId } })
      expect((await req(me.jar, 'GET', '/api/drops/today')).data.drops.map((d: { candidate: { id: string } }) => d.candidate.id)).toContain(target)
    })

    it('hides a drop whose account has been deleted', async () => {
      const victim = await person({ skills: [[httpSkill, 5]] })
      await testPrisma.drop.create({ data: { userId: me.userId, candidateId: victim.id, connectionType: 'COFOUNDER', score: 99, localDate: localDateKey(new Date(), null), expiresAt: new Date(Date.now() + DAY_MS) } })
      expect((await req(me.jar, 'GET', '/api/drops/today')).data.drops.map((d: { candidate: { id: string } }) => d.candidate.id)).toContain(victim.id)
      await testPrisma.user.update({ where: { id: victim.id }, data: { deletedAt: new Date() } })
      expect((await req(me.jar, 'GET', '/api/drops/today')).data.drops.map((d: { candidate: { id: string } }) => d.candidate.id)).not.toContain(victim.id)
    })

    it('passes on a drop: it is marked PASSED with a snapshot of the person, and passing again is fine', async () => {
      const list = await req(me.jar, 'GET', '/api/drops/today')
      const drop = list.data.drops[list.data.drops.length - 1]
      const res = await req(me.jar, 'POST', `/api/drops/${drop.id}/pass`)
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ id: drop.id, status: 'PASSED' })
      const row = await testPrisma.drop.findUniqueOrThrow({ where: { id: drop.id } })
      expect(row.status).toBe('PASSED')
      expect(row.passSnapshot).toMatchObject({ tier: expect.any(String), verifiedEvidence: expect.any(Number) })
      expect((await req(me.jar, 'POST', `/api/drops/${drop.id}/pass`)).data).toEqual({ id: drop.id, status: 'PASSED' })
      expect((await req(me.jar, 'GET', '/api/drops/today')).data.drops.find((d: { id: string }) => d.id === drop.id).status).toBe('PASSED')
    })

    it('keeps a passed person out of the next days’ drops', async () => {
      const passed = (await testPrisma.drop.findMany({ where: { userId: me.userId, status: 'PASSED' } }))[0]
      const tomorrow = new Date(Date.now() + DAY_MS)
      await testPrisma.drop.updateMany({ where: { userId: me.userId, localDate: localDateKey(new Date(), null) }, data: { createdAt: daysAgo(10) } })
      await generate(me.userId, { at: tomorrow, force: true })
      const fresh = await testPrisma.drop.findMany({ where: { userId: me.userId, localDate: localDateKey(tomorrow, null) } })
      expect(fresh.map((d) => d.candidateId)).not.toContain(passed.candidateId)
    })

    it('cannot pass somebody else’s drop, a drop that does not exist, or one already answered', async () => {
      const mine = (await testPrisma.drop.findMany({ where: { userId: me.userId, status: 'NEW' } }))[0]
      const stranger = await req(other.jar, 'POST', `/api/drops/${mine.id}/pass`)
      expect(stranger.status).toBe(404)
      expect(stranger.data.error.code).toBe('DROP_NOT_FOUND')
      expect((await req(me.jar, 'POST', '/api/drops/not-a-drop/pass')).status).toBe(404)
      expect((await testPrisma.drop.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('NEW')

      await testPrisma.drop.update({ where: { id: mine.id }, data: { status: 'SPARKED' } })
      const sparked = await req(me.jar, 'POST', `/api/drops/${mine.id}/pass`)
      expect(sparked.status).toBe(409)
      expect(sparked.data.error.code).toBe('DROP_NOT_PENDING')
      await testPrisma.drop.update({ where: { id: mine.id }, data: { status: 'NEW', expiresAt: daysAgo(1) } })
      expect((await req(me.jar, 'POST', `/api/drops/${mine.id}/pass`)).data.error.code).toBe('DROP_NOT_PENDING')
    })

    it('runs as jobs an admin can trigger, and nobody else can', async () => {
      expect((await req(me.jar, 'POST', '/api/admin/jobs/drops/generate')).status).toBe(403)
      expect((await req(me.jar, 'POST', '/api/admin/jobs/drops/expire')).status).toBe(403)
      const generated = await req(admin.jar, 'POST', '/api/admin/jobs/drops/generate', { data: { userIds: [me.userId] } })
      expect(generated.status).toBe(200)
      expect(generated.data.result).toMatchObject({ due: 1 })
      const expired = await req(admin.jar, 'POST', '/api/admin/jobs/drops/expire')
      expect(expired.status).toBe(200)
      expect(expired.data.result).toEqual({ expired: expect.any(Number) })
      expect((await req(admin.jar, 'POST', '/api/admin/jobs/drops/generate', { data: { userIds: 'x' } })).status).toBe(400)
    })
  })
})
