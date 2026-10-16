import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, daysAgo, makePerson, makeSkills, removePeople, type FixtureOptions } from './matching-fixtures'
import { generateSecondLookForUser, runSecondLook } from '../../src/lib/matching/second-look'
import { localDateKey } from '../../src/lib/time'
import { xpAtLevelStart } from '../../src/lib/levels'

const DAY_MS = 24 * 60 * 60 * 1000

describe('the weekly second look', () => {
  const suffix = uniqueSuffix()
  const tag = `sl${suffix}`
  let slugs: string[] = []
  let ml = ''

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    slugs = await makeSkills(tag, ['ml'])
    ;[ml] = slugs
  })
  afterAll(async () => {
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { in: slugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  const person = (options: Partial<FixtureOptions> = {}) => makePerson({ tag, ...options })
  const now = () => new Date()
  const secondLooks = (userId: string) => testPrisma.drop.findMany({ where: { userId, secondLook: true }, orderBy: { createdAt: 'asc' } })

  /** A pass `daysOld` days ago, with the snapshot the candidate looked like then. */
  async function passed(viewerId: string, candidateId: string, over: { daysOld?: number; tier?: string; verifiedEvidence?: number | null; type?: 'COFOUNDER' | 'DATING' | 'MENTEE'; snapshot?: unknown; at?: Date } = {}) {
    const daysOld = over.daysOld ?? 30
    const at = (days: number) => new Date((over.at ?? new Date()).getTime() - days * DAY_MS)
    return testPrisma.drop.create({
      data: {
        userId: viewerId,
        candidateId,
        connectionType: over.type ?? 'COFOUNDER',
        score: 60,
        localDate: at(daysOld).toISOString().slice(0, 10),
        status: 'PASSED',
        passSnapshot: (over.snapshot ?? (over.verifiedEvidence === null ? undefined : { tier: over.tier ?? 'BRONZE', verifiedEvidence: over.verifiedEvidence ?? 0 })) as never,
        expiresAt: at(daysOld - 1),
        createdAt: at(daysOld + 1),
        updatedAt: at(daysOld),
      },
    })
  }
  /** The coming Monday at noon UTC, a few days ahead: far enough from "now" to be a different moment, near enough that everyone is still active and trusted. */
  const nextMonday = () => {
    const d = new Date()
    const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)
    const ahead = ((8 - new Date(base).getUTCDay()) % 7) || 7
    return new Date(base + ahead * DAY_MS)
  }
  const addEvidence = async (userId: string, count: number) => {
    const skill = await testPrisma.skill.findUniqueOrThrow({ where: { slug: ml } })
    for (let i = 0; i < count; i++) await testPrisma.skillEvidence.create({ data: { userId, skillId: skill.id, type: 'GITHUB_PROJECT', title: `Proof ${i}`, verifiedAt: new Date() } })
  }

  it('resurfaces a passed person whose verified evidence has grown, as an extra flagged drop with the growth first', async () => {
    const viewer = await person({ lookingForSkills: [ml] })
    const grew = await person({ skills: [[ml, 4]] })
    await passed(viewer.id, grew.id, { verifiedEvidence: 0 })
    await addEvidence(grew.id, 2)

    const result = await generateSecondLookForUser(testPrisma, viewer.id, now(), {})
    expect(result).toMatchObject({ created: 1 })
    const [drop] = await secondLooks(viewer.id)
    expect(drop).toMatchObject({ candidateId: grew.id, secondLook: true, status: 'NEW', connectionType: 'COFOUNDER', localDate: localDateKey(now(), null) })
    expect((drop.reasons as string[])[0]).toBe('Since you last saw them they added 2 verified proofs of their work')
    expect((drop.reasons as string[]).length).toBeLessThanOrEqual(3)
    expect(drop.score).toBeGreaterThan(0)
    expect(drop.passSnapshot).toBeNull()
    expect(drop.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('resurfaces a person who moved up a tier', async () => {
    const viewer = await person()
    const climbed = await person({ xp: xpAtLevelStart(40) })
    await passed(viewer.id, climbed.id, { tier: 'BRONZE' })
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 1 })
    const [drop] = await secondLooks(viewer.id)
    expect(drop.candidateId).toBe(climbed.id)
    expect((drop.reasons as string[])[0]).toMatch(/^Since you last saw them they moved up to /)
  })

  it('does not resurface anybody who has not grown, or whose snapshot is missing or unreadable', async () => {
    const viewer = await person()
    const same = await person()
    const unknown = await person()
    const garbled = await person()
    await passed(viewer.id, same.id, { tier: 'BRONZE', verifiedEvidence: 0 })
    await passed(viewer.id, unknown.id, { verifiedEvidence: null })
    await passed(viewer.id, garbled.id, { snapshot: { tier: 'NOT_A_TIER', verifiedEvidence: 'many' } })
    await addEvidence(unknown.id, 3)
    await addEvidence(garbled.id, 3)
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 0 })
    expect(await secondLooks(viewer.id)).toEqual([])
  })

  it('only looks at passes that are neither too fresh nor too old', async () => {
    const viewer = await person()
    const fresh = await person()
    const ancient = await person()
    await passed(viewer.id, fresh.id, { daysOld: 5 })
    await passed(viewer.id, ancient.id, { daysOld: 200 })
    await addEvidence(fresh.id, 2)
    await addEvidence(ancient.id, 2)
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 0 })
    const ok = await person()
    await passed(viewer.id, ok.id, { daysOld: 14 })
    await addEvidence(ok.id, 1)
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 1 })
  })

  it('picks the person who grew most, and ties go to the more recent pass', async () => {
    const viewer = await person()
    const small = await person()
    const big = await person()
    await passed(viewer.id, small.id, { daysOld: 40 })
    await passed(viewer.id, big.id, { daysOld: 60 })
    await addEvidence(small.id, 1)
    await addEvidence(big.id, 4)
    await generateSecondLookForUser(testPrisma, viewer.id, now(), {})
    expect((await secondLooks(viewer.id)).map((d) => d.candidateId)).toEqual([big.id])

    const viewer2 = await person()
    const older = await person()
    const newer = await person()
    await passed(viewer2.id, older.id, { daysOld: 70 })
    await passed(viewer2.id, newer.id, { daysOld: 20 })
    await addEvidence(older.id, 2)
    await addEvidence(newer.id, 2)
    await generateSecondLookForUser(testPrisma, viewer2.id, now(), {})
    expect((await secondLooks(viewer2.id)).map((d) => d.candidateId)).toEqual([newer.id])
  })

  it('gives one a week, however often the job runs, and another the next week', async () => {
    const viewer = await person()
    const first = await person()
    const second = await person()
    const monday = nextMonday()
    await passed(viewer.id, first.id, { daysOld: 40, at: monday })
    await passed(viewer.id, second.id, { daysOld: 41, at: monday })
    await addEvidence(first.id, 3)
    await addEvidence(second.id, 2)
    expect(await generateSecondLookForUser(testPrisma, viewer.id, monday, {})).toMatchObject({ created: 1 })
    expect(await generateSecondLookForUser(testPrisma, viewer.id, new Date(monday.getTime() + 2 * DAY_MS), {})).toMatchObject({ created: 0, skipped: 'ALREADY_THIS_WEEK' })
    expect(await generateSecondLookForUser(testPrisma, viewer.id, new Date(monday.getTime() + 6 * DAY_MS + 11 * 3_600_000), {})).toMatchObject({ created: 0, skipped: 'ALREADY_THIS_WEEK' })
    expect((await secondLooks(viewer.id)).map((d) => d.candidateId)).toEqual([first.id])
    // The next Monday is a new week: the one who is left comes back.
    expect(await generateSecondLookForUser(testPrisma, viewer.id, new Date(monday.getTime() + 7 * DAY_MS), {})).toMatchObject({ created: 1 })
    expect((await secondLooks(viewer.id)).map((d) => d.candidateId)).toEqual([first.id, second.id])
  })

  it('counts the week in the person’s own time zone', async () => {
    const monday = nextMonday()
    const sunday = new Date(monday.getTime() - DAY_MS) // 12:00 UTC on a Sunday: already Monday 02:00 in Kiritimati (UTC+14)
    const sundayKey = sunday.toISOString().slice(0, 10)
    const earlier = await person()
    const make = async (timezone: string | null) => {
      const viewer = await person({ timezone })
      const a = await person()
      await passed(viewer.id, a.id, { daysOld: 40, at: sunday })
      await addEvidence(a.id, 2)
      // A second look given earlier that Sunday (the viewer's own Sunday, in the zone they were in).
      await testPrisma.drop.create({ data: { userId: viewer.id, candidateId: earlier.id, connectionType: 'COFOUNDER', score: 50, localDate: sundayKey, secondLook: true, expiresAt: sunday } })
      return viewer
    }
    const islander = await make('Pacific/Kiritimati')
    const utc = await make(null)
    expect(await generateSecondLookForUser(testPrisma, islander.id, sunday, {})).toMatchObject({ created: 1 })
    expect(await generateSecondLookForUser(testPrisma, utc.id, sunday, {})).toMatchObject({ created: 0, skipped: 'ALREADY_THIS_WEEK' })
  })

  it('is extra: it does not use up the daily allowance of ordinary drops', async () => {
    const { generateDropsForUser } = await import('../../src/lib/matching/drops')
    const viewer = await person({ lookingForSkills: [ml] })
    const grew = await person({ skills: [[ml, 2]] })
    for (let i = 0; i < 5; i++) await person({ skills: [[ml, 3]] })
    await passed(viewer.id, grew.id, { daysOld: 30 })
    await addEvidence(grew.id, 2)
    await generateSecondLookForUser(testPrisma, viewer.id, now(), {})
    const ordinary = await generateDropsForUser(testPrisma, viewer.id, now(), { enforced: true })
    expect(ordinary.created).toBe(3)
    expect(await testPrisma.drop.count({ where: { userId: viewer.id, secondLook: false, status: 'NEW' } })).toBe(3)
    expect(await testPrisma.drop.count({ where: { userId: viewer.id, secondLook: true } })).toBe(1)
  })

  it('skips a grown person who is no longer eligible: blocked, matched, paused, deleted, untrusted, dating-ineligible', async () => {
    const viewer = await person({ types: ['COFOUNDER', 'DATING'], birthDate: bornYearsAgo(30), phone: true })
    const blocked = await person()
    const matched = await person()
    const paused = await person()
    const gone = await person()
    const young = await person({ ageDays: 2 })
    const datingLost = await person({ types: ['DATING'], birthDate: bornYearsAgo(30), phone: true })
    for (const c of [blocked, matched, paused, gone, young]) await passed(viewer.id, c.id, { daysOld: 40 })
    await passed(viewer.id, datingLost.id, { daysOld: 40, type: 'DATING' })
    for (const c of [blocked, matched, paused, gone, young, datingLost]) await addEvidence(c.id, 2)
    await testPrisma.block.create({ data: { blockerId: viewer.id, blockedId: blocked.id } })
    const [a, b] = viewer.id < matched.id ? [viewer.id, matched.id] : [matched.id, viewer.id]
    await testPrisma.match.create({ data: { userAId: a, userBId: b, userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COFOUNDER' } })
    await testPrisma.matchingProfile.update({ where: { userId: paused.id }, data: { paused: true } })
    await testPrisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
    await testPrisma.user.update({ where: { id: datingLost.id }, data: { isPhoneVerified: false } })
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 0 })
    expect(await secondLooks(viewer.id)).toEqual([])
  })

  it('does not bring back a person for a type the viewer no longer has', async () => {
    const viewer = await person({ types: ['COLLABORATOR'] })
    const c = await person({ types: ['COFOUNDER', 'COLLABORATOR'] })
    await passed(viewer.id, c.id, { daysOld: 40, type: 'COFOUNDER' })
    await addEvidence(c.id, 2)
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 0 })
  })

  it('does nothing for a viewer who is paused, has no profile or is gone', async () => {
    const paused = await person({ paused: true })
    const bare = await person({ profile: false })
    const gone = await person({ deleted: true })
    expect(await generateSecondLookForUser(testPrisma, paused.id, now(), {})).toMatchObject({ created: 0, skipped: 'PAUSED' })
    expect(await generateSecondLookForUser(testPrisma, bare.id, now(), {})).toMatchObject({ created: 0, skipped: 'NO_PROFILE' })
    expect(await generateSecondLookForUser(testPrisma, gone.id, now(), {})).toMatchObject({ created: 0, skipped: 'GONE' })
  })

  it('does not collide with an ordinary drop for the same person on the same day', async () => {
    const viewer = await person()
    const grew = await person()
    const earlier = await passed(viewer.id, grew.id, { daysOld: 40 })
    await addEvidence(grew.id, 2)
    const today = localDateKey(now(), null)
    await testPrisma.drop.create({ data: { userId: viewer.id, candidateId: grew.id, connectionType: 'COFOUNDER', score: 70, localDate: today, expiresAt: new Date(Date.now() + DAY_MS) } })
    expect(await generateSecondLookForUser(testPrisma, viewer.id, now(), {})).toMatchObject({ created: 0 })
    expect(earlier.id).toBeTruthy()
  })

  it('runs for everyone who has such a pass, or for exactly the people named', async () => {
    const a = await person()
    const b = await person()
    const c1 = await person()
    const c2 = await person()
    await passed(a.id, c1.id, { daysOld: 40 })
    await passed(b.id, c2.id, { daysOld: 40 })
    await addEvidence(c1.id, 2)
    await addEvidence(c2.id, 2)
    const named = await runSecondLook(testPrisma, { userIds: [a.id, 'nobody'] })
    expect(named).toMatchObject({ users: 2, created: 1 })
    expect((await secondLooks(a.id)).length).toBe(1)
    expect((await secondLooks(b.id)).length).toBe(0)
    const everyone = await runSecondLook(testPrisma, {})
    expect(everyone.created).toBeGreaterThanOrEqual(1)
    expect((await secondLooks(b.id)).length).toBe(1)
    // And again changes nothing.
    expect(await runSecondLook(testPrisma, {})).toMatchObject({ created: 0 })
  })

  it('shows up in GET /api/drops/today flagged, and passing it again is possible', async () => {
    const me = await registerAndLogin(`${tag}.me@test.dev`, `${tag}me`)
    await testPrisma.matchingProfile.create({ data: { userId: me.userId, connectionTypes: ['COFOUNDER'], dropTimeLocal: '23:59' } })
    const grew = await person({ skills: [[ml, 4]] })
    await passed(me.userId, grew.id, { daysOld: 40 })
    await addEvidence(grew.id, 2)
    const job = await req((await registerAndLogin(`${tag}.admin@test.dev`, `${tag}admin`)).jar, 'POST', '/api/admin/jobs/drops/second-look', { data: { userIds: [me.userId] } })
    expect(job.status).toBe(403)
    await generateSecondLookForUser(testPrisma, me.userId, now(), {})
    const today = await req(me.jar, 'GET', '/api/drops/today')
    const drop = today.data.drops.find((d: { secondLook: boolean }) => d.secondLook)
    expect(drop).toMatchObject({ secondLook: true, status: 'NEW', connectionType: 'COFOUNDER', candidate: { id: grew.id } })
    expect(drop.reasons[0]).toContain('Since you last saw them')
    expect((await req(me.jar, 'POST', `/api/drops/${drop.id}/pass`)).data.status).toBe('PASSED')
    // The new pass has its own snapshot, so the second look compares against what they look like now.
    expect((await testPrisma.drop.findUniqueOrThrow({ where: { id: drop.id } })).passSnapshot).toMatchObject({ verifiedEvidence: 2 })
  })
})
