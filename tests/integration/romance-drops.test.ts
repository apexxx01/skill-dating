import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, removePeople } from './matching-fixtures'
import { giveEndorsers, makeRomancePerson, type RomanceFixtureOptions } from './romance-fixtures'
import { findRomanceCandidateIds, type RomanceViewer } from '../../src/lib/romance/candidates'
import { dispatchRomanceDrops, dropTimePassed, dueRomanceByZone, generateRomanceDropForUser, runRomanceDropGeneration } from '../../src/lib/romance/drops'
import { mutuallyAccept, inboxAllows, type FilterFacts } from '../../src/lib/romance/filters'
import { ageOn } from '../../src/lib/age'
import { ROMANCE_CONFIG, GENDERS, SCOPES, ROMANCE_MODE_LABEL, type Gender, type Scope } from '../../src/lib/romance/config'
import { jobs } from '../../src/lib/infra/jobs'
import { MemoryJobQueue } from '../../src/lib/infra/jobs.memory'
import { localWeekKey } from '../../src/lib/time'

const DAY_MS = 24 * 60 * 60 * 1000

describe('the weekly romance drop', () => {
  const suffix = uniqueSuffix()
  const tag = `rd${suffix}`

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await testPrisma.notification.deleteMany({ where: { user: { username: { startsWith: tag.toLowerCase() } } } })
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { startsWith: `${tag}` } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  const person = (options: RomanceFixtureOptions = {}) => makeRomancePerson({ tag, ...options })
  const now = () => new Date()
  const viewerOf = async (userId: string, endorsers = 0): Promise<RomanceViewer> => {
    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: userId }, include: { romanceProfile: true, profile: true } })
    const rp = row.romanceProfile!
    return {
      userId,
      gender: rp.gender,
      interestedIn: rp.interestedIn,
      ageMin: rp.ageMin,
      ageMax: rp.ageMax,
      scope: rp.scope,
      age: ageOn(row.birthDate!, now()),
      cityKey: row.profile?.cityKey ?? null,
      countryCode: row.profile?.countryCode ?? null,
      endorsers,
    }
  }
  const pool = async (userId: string, endorsers = 0, onlyIds?: string[]) => findRomanceCandidateIds(testPrisma, await viewerOf(userId, endorsers), now(), { onlyIds, limit: 5000 })
  const dropsOf = (userId: string) => testPrisma.romanceDrop.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
  const generate = (userId: string, over: { at?: Date; force?: boolean } = {}) => generateRomanceDropForUser(testPrisma, userId, over.at ?? now(), { force: over.force })

  describe('who may be shown to whom: the SQL and the pure rule agree', () => {
    it('gives the same answer for every combination of gender, age range and scope, in both directions', async () => {
      // Six people for each of the four genders and three scopes would be 72; a fixed spread of 24 covers every pair of values and every direction.
      const people: { id: string; facts: FilterFacts }[] = []
      const places = [
        { cityKey: `pune-${suffix}`, countryCode: 'IN' },
        { cityKey: `delhi-${suffix}`, countryCode: 'IN' },
        { cityKey: `berlin-${suffix}`, countryCode: 'DE' },
        { cityKey: null, countryCode: null },
      ]
      for (let i = 0; i < 24; i++) {
        const gender = GENDERS[i % 4] as Gender
        const interestedIn = [GENDERS[(i + 1) % 4], GENDERS[(i + (i % 3 === 0 ? 0 : 2)) % 4]].filter((g, k, all) => all.indexOf(g) === k) as Gender[]
        const scope = SCOPES[i % 3] as Scope
        const age = 20 + ((i * 5) % 25)
        const ageMin = 18 + (i % 4) * 4
        const ageMax = Math.max(ageMin, 28 + (i % 5) * 6)
        const place = places[i % 4]
        const created = await person({ gender, interestedIn, scope, age, ageMin, ageMax, cityKey: place.cityKey ?? undefined, countryCode: place.countryCode })
        people.push({
          id: created.id,
          facts: { gender, interestedIn, ageMin, ageMax, scope, age: ageOn(new Date(`${bornYearsAgo(age, 100)}T00:00:00Z`), now()), cityKey: place.cityKey, countryCode: place.countryCode },
        })
      }
      const ids = people.map((p) => p.id)
      let checked = 0
      let shown = 0
      for (const viewer of people) {
        const inPool = new Set(await pool(viewer.id, 0, ids))
        for (const other of people) {
          if (other.id === viewer.id) continue
          const expected = mutuallyAccept(viewer.facts, other.facts).ok
          expect(inPool.has(other.id), `${viewer.id} -> ${other.id}: ${JSON.stringify([viewer.facts, other.facts])}`).toBe(expected)
          checked += 1
          if (expected) shown += 1
        }
      }
      expect(checked).toBe(24 * 23)
      // A spread that exercised both outcomes.
      expect(shown).toBeGreaterThan(30)
      expect(shown).toBeLessThan(checked - 30)
    }, 120_000)

    it('refuses on one side even when the other would accept (asymmetric cases)', async () => {
      const woman = await person({ gender: 'WOMAN', interestedIn: ['MAN'], age: 30, ageMin: 25, ageMax: 40 })
      const manWhoWantsMen = await person({ gender: 'MAN', interestedIn: ['MAN'], age: 30, ageMin: 18, ageMax: 99 })
      const youngerMan = await person({ gender: 'MAN', interestedIn: ['WOMAN'], age: 24, ageMin: 18, ageMax: 99 })
      const pickyMan = await person({ gender: 'MAN', interestedIn: ['WOMAN'], age: 33, ageMin: 18, ageMax: 28 })
      const pune = `pune-${suffix}`
      const homeBody = await person({ gender: 'MAN', interestedIn: ['WOMAN'], age: 31, scope: 'CITY', cityKey: pune, countryCode: 'IN' })
      const farAway = await person({ gender: 'WOMAN', interestedIn: ['MAN'], age: 31, scope: 'ANYWHERE', cityKey: `berlin-${suffix}`, countryCode: 'DE' })
      const goodMan = await person({ gender: 'MAN', interestedIn: ['WOMAN'], age: 33, ageMin: 25, ageMax: 40 })
      const ids = [woman.id, manWhoWantsMen.id, youngerMan.id, pickyMan.id, homeBody.id, farAway.id, goodMan.id]
      const forWoman = await pool(woman.id, 0, ids)
      expect(forWoman).toContain(goodMan.id)
      expect(forWoman).not.toContain(manWhoWantsMen.id) // she would, he would not
      expect(forWoman).not.toContain(youngerMan.id) // he would, she (25 to 40) would not take 24
      expect(forWoman).not.toContain(pickyMan.id) // she would, he (up to 28) would not take 30
      expect(forWoman).not.toContain(homeBody.id) // her scope is anywhere, his is her city only and she is elsewhere
      expect(await pool(manWhoWantsMen.id, 0, ids)).not.toContain(woman.id)
      expect(await pool(pickyMan.id, 0, ids)).not.toContain(woman.id)
      const homeBodyPool = await pool(homeBody.id, 0, ids)
      expect(homeBodyPool).not.toContain(farAway.id)
      expect(homeBodyPool).not.toContain(woman.id)
    }, 120_000)
  })

  describe('who is never in the pool', () => {
    it('leaves out everybody who is not an established, eligible, active adult in the mode', async () => {
      const viewer = await person()
      const control = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const minor = await person({ gender: 'MAN', interestedIn: ['WOMAN'], birthDate: bornYearsAgo(17) })
      const dayShort = await person({ gender: 'MAN', interestedIn: ['WOMAN'], birthDate: bornYearsAgo(18, -1) })
      const noBirth = await person({ gender: 'MAN', interestedIn: ['WOMAN'], birthDate: null })
      const unverified = await person({ gender: 'MAN', interestedIn: ['WOMAN'], emailVerified: false })
      const noContact = await person({ gender: 'MAN', interestedIn: ['WOMAN'], phone: false, github: false })
      const github = await person({ gender: 'MAN', interestedIn: ['WOMAN'], phone: false, github: true })
      const young = await person({ gender: 'MAN', interestedIn: ['WOMAN'], ageDays: 3 })
      const dormant = await person({ gender: 'MAN', interestedIn: ['WOMAN'], lastActiveDaysAgo: 90 })
      const paused = await person({ gender: 'MAN', interestedIn: ['WOMAN'], paused: true })
      const gone = await person({ gender: 'MAN', interestedIn: ['WOMAN'], deleted: true })
      const notJoined = await person({ gender: 'MAN', romance: false })
      const ids = [control, minor, dayShort, noBirth, unverified, noContact, github, young, dormant, paused, gone, notJoined].map((p) => p.id)
      const got = await pool(viewer.id, 0, ids)
      expect(got.sort()).toEqual([control.id, github.id].sort())
    }, 120_000)

    it('leaves out blocked people either way, matched and sparked people, and a pair whose match ended', async () => {
      const viewer = await person()
      const blockedByMe = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const blockedMe = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const matched = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const endedPro = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const openPro = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const sparked = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const control = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      await testPrisma.block.create({ data: { blockerId: viewer.id, blockedId: blockedByMe.id } })
      await testPrisma.block.create({ data: { blockerId: blockedMe.id, blockedId: viewer.id } })
      const pairOf = (a: string, b: string) => (a < b ? [a, b] : [b, a])
      const matchRow = (other: string, type: 'DATING' | 'COFOUNDER', ended: boolean) => {
        const [userAId, userBId] = pairOf(viewer.id, other)
        return testPrisma.match.create({ data: { userAId, userBId, userARole: type, userBRole: type, connectionType: type, endedAt: ended ? new Date() : null, endReason: ended ? 'UNMATCHED' : null } })
      }
      await matchRow(matched.id, 'DATING', false)
      await matchRow(endedPro.id, 'COFOUNDER', true)
      await matchRow(openPro.id, 'COFOUNDER', false)
      await testPrisma.spark.create({ data: { fromId: viewer.id, toId: sparked.id, connectionType: 'DATING', opener: 'z'.repeat(40), openerHash: `rd1${suffix}` } })
      const ids = [blockedByMe, blockedMe, matched, endedPro, openPro, sparked, control].map((p) => p.id)
      const got = await pool(viewer.id, 0, ids)
      // An open PROFESSIONAL match with someone does not stop a romance drop; an ended match of any kind is final.
      expect(got.sort()).toEqual([control.id, openPro.id].sort())
    }, 120_000)

    it('does not show anyone again within the cooldown, and not a candidate already shown to the weekly cap of people', async () => {
      const viewer = await person()
      const shownLately = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const shownLongAgo = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const popular = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const control = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const expires = new Date(Date.now() + DAY_MS)
      await testPrisma.romanceDrop.create({ data: { userId: viewer.id, candidateId: shownLately.id, score: 60, weekKey: '2020-W01', expiresAt: expires, createdAt: new Date(Date.now() - 10 * DAY_MS) } })
      await testPrisma.romanceDrop.create({ data: { userId: viewer.id, candidateId: shownLongAgo.id, score: 60, weekKey: '2019-W01', expiresAt: expires, createdAt: new Date(Date.now() - (ROMANCE_CONFIG.drop.repeatCooldownDays + 5) * DAY_MS) } })
      const others = []
      for (let i = 0; i < ROMANCE_CONFIG.drop.exposureCapPerWeek; i++) others.push(await person({ gender: 'WOMAN', interestedIn: ['MAN'] }))
      await testPrisma.romanceDrop.createMany({ data: others.map((other, i) => ({ userId: other.id, candidateId: popular.id, score: 50, weekKey: `2031-W${String(i + 1).padStart(2, '0')}`, expiresAt: expires })) })
      const got = await pool(viewer.id, 0, [shownLately.id, shownLongAgo.id, popular.id, control.id])
      expect(got.sort()).toEqual([control.id, shownLongAgo.id].sort())
    }, 180_000)
  })

  describe('the inbox gate: only people endorsed by enough builders can spark me', () => {
    it('shows a person to somebody who has at least as many trusted endorsers as they ask for', async () => {
      const gated = await person({ gender: 'MAN', interestedIn: ['WOMAN'], minEndorsements: 2 })
      const open = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const viewer = await person()
      const ids = [gated.id, open.id]
      expect(await pool(viewer.id, 0, ids)).toEqual([open.id])
      expect(await pool(viewer.id, 1, ids)).toEqual([open.id])
      expect((await pool(viewer.id, 2, ids)).sort()).toEqual([gated.id, open.id].sort())
      expect(inboxAllows(2, 2)).toBe(true)
    }, 120_000)

    it('counts distinct trusted builders, not endorsements and not new accounts', async () => {
      const { countCharacterEndorsers } = await import('../../src/lib/romance/endorsers')
      const subject = await person()
      await giveEndorsers(tag, subject.id, 2)
      // The same endorser vouching for another piece of evidence is still one builder.
      const first = await testPrisma.skillEvidence.findFirstOrThrow({ where: { userId: subject.id, type: 'PEER_ENDORSEMENT' } })
      await testPrisma.skillEvidence.create({ data: { userId: subject.id, skillId: first.skillId, type: 'PEER_ENDORSEMENT', title: 'again', metadata: first.metadata ?? {} } })
      // A fresh account and an unverified one do not count.
      const young = await person({ ageDays: 2 })
      const unverified = await person({ emailVerified: false })
      for (const endorser of [young, unverified]) {
        await testPrisma.skillEvidence.create({ data: { userId: subject.id, skillId: first.skillId, type: 'PEER_ENDORSEMENT', title: 'sock', metadata: { endorsedEvidenceId: 'x', endorserId: endorser.id } } })
      }
      expect((await countCharacterEndorsers(testPrisma, [subject.id])).get(subject.id)).toBe(2)
    }, 120_000)
  })

  describe('making the drop', () => {
    it('gives the best-scoring person, with the lines that explain it, once, and tells the person', async () => {
      const viewer = await person({ obsessions: ['climate tech', 'rust'], rhythm: 'night-owl', direction: 'founder', ambition: 3 })
      const close = await person({ gender: 'MAN', interestedIn: ['WOMAN'], obsessions: ['climate tech', 'rust'], rhythm: 'night-owl', direction: 'founder', ambition: 3 })
      const far = await person({ gender: 'MAN', interestedIn: ['WOMAN'], obsessions: ['wine'], rhythm: 'early-bird', direction: 'steady-career', ambition: 1 })
      const at = new Date()
      const result = await generate(viewer.id, { at })
      expect(result).toMatchObject({ created: 1 })
      const drops = await dropsOf(viewer.id)
      expect(drops).toHaveLength(1)
      expect(drops[0].candidateId).toBe(close.id)
      expect(drops[0].score).toBeGreaterThanOrEqual(ROMANCE_CONFIG.drop.minScore)
      expect((drops[0].reasons as string[])[0]).toBe("You're both night-owl builders obsessed with climate tech and rust")
      expect(drops[0].weekKey).toBe(localWeekKey(at, null))
      expect(drops[0].status).toBe('NEW')
      expect(drops[0].expiresAt.getTime()).toBeGreaterThan(at.getTime())
      expect(far.id).toBeTruthy()
      const marker = await testPrisma.romanceProfile.findUniqueOrThrow({ where: { userId: viewer.id } })
      expect(marker.lastDropWeek).toBe(drops[0].weekKey)
      const notice = await testPrisma.notification.findMany({ where: { userId: viewer.id } })
      expect(notice).toHaveLength(1)
      expect(notice[0]).toMatchObject({ title: `Your ${ROMANCE_MODE_LABEL} pick for the week is here` })
      expect(notice[0].metadata).toMatchObject({ kind: 'ROMANCE_DROP' })

      // The same week again: nothing.
      expect(await generate(viewer.id, { at })).toMatchObject({ created: 0, skipped: 'ALREADY_GENERATED' })
      expect(await dropsOf(viewer.id)).toHaveLength(1)
    }, 120_000)

    it('gives the next week a new person, never the one just shown', async () => {
      const viewer = await person()
      const a = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const b = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const week1 = new Date()
      const week2 = new Date(week1.getTime() + 7 * DAY_MS)
      await generate(viewer.id, { at: week1 })
      await generate(viewer.id, { at: week2 })
      const drops = await dropsOf(viewer.id)
      expect(drops).toHaveLength(2)
      expect(new Set(drops.map((d) => d.candidateId)).size).toBe(2)
      expect(drops.map((d) => d.weekKey)).toEqual([localWeekKey(week1, null), localWeekKey(week2, null)])
      expect([a.id, b.id]).toEqual(expect.arrayContaining([drops[0].candidateId]))
    }, 120_000)

    it('looks for a week with nobody once a day, not every hour, and marks the week only when it finds someone', async () => {
      const loner = await person({ gender: 'NON_BINARY', interestedIn: ['SELF_DESCRIBED'], scope: 'CITY', cityKey: `lonely-${suffix}`, countryCode: 'IN' })
      const at = new Date()
      expect(await generate(loner.id, { at })).toMatchObject({ created: 0 })
      const first = await testPrisma.romanceProfile.findUniqueOrThrow({ where: { userId: loner.id } })
      expect(first.lastDropWeek).toBeNull()
      expect(first.lastDropTryDate).not.toBeNull()
      // Not due again the same local day; due again the next.
      const sameDay = (await dueRomanceByZone(testPrisma, new Date('2031-06-05T12:00:00Z'))).flatMap((zone) => zone.ids)
      expect(sameDay).toContain(loner.id)
      await testPrisma.romanceProfile.update({ where: { userId: loner.id }, data: { lastDropTryDate: '2031-06-05' } })
      expect((await dueRomanceByZone(testPrisma, new Date('2031-06-05T12:00:00Z'))).flatMap((zone) => zone.ids)).not.toContain(loner.id)
      expect((await dueRomanceByZone(testPrisma, new Date('2031-06-06T12:00:00Z'))).flatMap((zone) => zone.ids)).toContain(loner.id)
    }, 120_000)

    it('skips the ones who should not get a drop: gone, not joined, paused, or no longer eligible', async () => {
      const gone = await person({ deleted: true })
      const none = await person({ romance: false })
      const paused = await person({ paused: true })
      const lost = await person()
      await testPrisma.user.update({ where: { id: lost.id }, data: { isPhoneVerified: false, githubConnected: false } })
      expect(await generate(gone.id)).toMatchObject({ created: 0, skipped: 'GONE' })
      expect(await generate(none.id)).toMatchObject({ created: 0, skipped: 'NO_PROFILE' })
      expect(await generate(paused.id)).toMatchObject({ created: 0, skipped: 'PAUSED' })
      expect(await generate(lost.id)).toMatchObject({ created: 0, skipped: 'NOT_ELIGIBLE' })
      expect(await generate('nobody')).toMatchObject({ skipped: 'GONE' })
    }, 120_000)

    it('is not told to a person who switched the notification off, and the drop is still made', async () => {
      const viewer = await person()
      await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      await testPrisma.notificationPreference.create({ data: { userId: viewer.id, kind: 'ROMANCE_DROP', enabled: false } })
      expect(await generate(viewer.id)).toMatchObject({ created: 1 })
      expect(await testPrisma.notification.count({ where: { userId: viewer.id } })).toBe(0)
    }, 120_000)

    it('two runs at once give nobody more than one', async () => {
      const viewer = await person()
      for (let i = 0; i < 4; i++) await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const results = await Promise.all([generate(viewer.id), generate(viewer.id), generate(viewer.id)])
      expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(1)
      expect(await dropsOf(viewer.id)).toHaveLength(1)
    }, 120_000)
  })

  describe('when drops are made', () => {
    it('is due from Monday 08:00 in the person\'s own zone, and for the rest of the week', async () => {
      // 2031-06-02 is a Monday. Kolkata is UTC+5:30.
      expect(dropTimePassed(new Date('2031-06-02T02:29:00Z'), 'Asia/Kolkata')).toBe(false) // 07:59
      expect(dropTimePassed(new Date('2031-06-02T02:30:00Z'), 'Asia/Kolkata')).toBe(true) // 08:00
      expect(dropTimePassed(new Date('2031-06-04T00:10:00Z'), 'Asia/Kolkata')).toBe(true) // Wednesday, before 08:00 clock time: the week's time has passed
      expect(dropTimePassed(new Date('2031-06-08T20:00:00Z'), 'UTC')).toBe(true) // Sunday
      const kolkata = await person({ timezone: 'Asia/Kolkata' })
      expect((await dueRomanceByZone(testPrisma, new Date('2031-06-02T02:29:00Z'))).flatMap((z) => z.ids)).not.toContain(kolkata.id)
      expect((await dueRomanceByZone(testPrisma, new Date('2031-06-02T02:30:00Z'))).flatMap((z) => z.ids)).toContain(kolkata.id)
      await testPrisma.romanceProfile.update({ where: { userId: kolkata.id }, data: { lastDropWeek: '2031-W23' } })
      expect((await dueRomanceByZone(testPrisma, new Date('2031-06-03T09:00:00Z'))).flatMap((z) => z.ids)).not.toContain(kolkata.id)
      expect((await dueRomanceByZone(testPrisma, new Date('2031-06-09T09:00:00Z'))).flatMap((z) => z.ids)).toContain(kolkata.id)
    }, 120_000)

    it('never lists a paused or deleted person', async () => {
      const paused = await person({ paused: true, timezone: 'UTC' })
      const gone = await person({ deleted: true, timezone: 'UTC' })
      const due = (await dueRomanceByZone(testPrisma, new Date('2031-06-04T12:00:00Z'))).flatMap((z) => z.ids)
      expect(due).not.toContain(paused.id)
      expect(due).not.toContain(gone.id)
    }, 60_000)

    it('is fanned out in batches per zone and run as jobs, and a batch run twice changes nothing', async () => {
      const zone = 'Pacific/Fiji'
      const people = []
      for (let i = 0; i < 5; i++) people.push(await person({ timezone: zone, gender: i % 2 ? 'MAN' : 'WOMAN', interestedIn: i % 2 ? ['WOMAN'] : ['MAN'] }))
      const at = new Date()
      const queue = new MemoryJobQueue(jobs)
      const dispatched = await dispatchRomanceDrops(testPrisma, queue, at, 2)
      expect(dispatched.batches).toBeGreaterThanOrEqual(3)
      const mine = queue.accepted.filter((job) => job.name === 'romance/drops-batch' && (job.id ?? '').includes(':Pacific_Fiji:'))
      expect(mine).toHaveLength(Math.ceil((await dueRomanceByZone(testPrisma, at)).find((z) => z.timezone === zone)!.ids.length / 2))
      const again = queue.accepted.length
      await dispatchRomanceDrops(testPrisma, queue, at, 2)
      expect(queue.accepted.length).toBe(again)
      const outcomes = await queue.drain()
      expect(outcomes.every((o) => o.ok)).toBe(true)
      for (const p of people) expect((await testPrisma.romanceProfile.findUniqueOrThrow({ where: { userId: p.id } })).lastDropTryDate).not.toBeNull()
      const counts = await Promise.all(people.map(async (p) => (await dropsOf(p.id)).length))
      const rerun = new MemoryJobQueue(jobs)
      await rerun.enqueue('romance/drops-batch', { userIds: people.map((p) => p.id) })
      expect((await rerun.drain())[0].ok).toBe(true)
      expect(await Promise.all(people.map(async (p) => (await dropsOf(p.id)).length))).toEqual(counts)
    }, 180_000)

    it('runs as a job, by name', async () => {
      expect(jobs['romance/drops'].schedule).toBe('25 * * * *')
      expect(jobs['romance/drops-batch'].concurrency).toBe(8)
      const viewer = await person()
      await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      const result = await runRomanceDropGeneration(testPrisma, { userIds: [viewer.id, 'nobody'] })
      expect(result).toMatchObject({ due: 2, generated: 1, skipped: 1 })
    }, 120_000)
  })

  describe('GET /api/romance/drop and the pass', () => {
    async function member(label: string, countryCode = 'IN') {
      const u = await registerAndLogin(`${tag}.${label}@test.dev`, `${tag}${label}`)
      await testPrisma.user.update({ where: { id: u.userId }, data: { isEmailVerified: true, isPhoneVerified: true, birthDate: new Date(`${bornYearsAgo(30)}T00:00:00Z`) } })
      await testPrisma.profile.create({ data: { userId: u.userId, countryCode } })
      await testPrisma.romanceProfile.create({
        data: {
          userId: u.userId, promptObsessed: 'Compilers and the people who love them, always.', promptBuild: 'A tool I would use every single day.', promptWeekend: 'Ship something small, then eat well.',
          ambition: 3, direction: 'founder', rhythm: 'night-owl', obsessions: ['compilers'], gender: 'WOMAN', interestedIn: ['MAN'], ageMin: 18, ageMax: 99, scope: 'ANYWHERE',
        },
      })
      return u
    }

    it('needs a signed-in user, and says "not joined" to somebody who has not', async () => {
      expect((await req(null, 'GET', '/api/romance/drop')).status).toBe(401)
      expect((await req(null, 'POST', '/api/romance/drop/x/pass', {})).status).toBe(401)
      const outsider = await registerAndLogin(`${tag}.outsider@test.dev`, `${tag}outsider`)
      const res = await req(outsider.jar, 'GET', '/api/romance/drop')
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ modeLabel: ROMANCE_MODE_LABEL, active: false, drop: null, nextDropAt: null })
    }, 60_000)

    it('shows the one person with as much as a stranger may see, no photo, no avatar and nothing private', async () => {
      const me = await member('me')
      const them = await person({ gender: 'MAN', interestedIn: ['WOMAN'], obsessions: ['compilers'], cityKey: `pune-${suffix}`, countryCode: 'IN' })
      await testPrisma.user.update({ where: { id: them.id }, data: { image: 'https://example.com/avatar.png', bio: 'A private-ish bio', location: 'Pune, India' } })
      const profile = await testPrisma.romanceProfile.findUniqueOrThrow({ where: { userId: them.id } })
      const asset = await testPrisma.mediaAsset.create({ data: { ownerId: them.id, purpose: 'ROMANCE_PHOTO', kind: 'IMAGE', key: `romance/${them.id}/${'a'.repeat(64)}.jpg`, contentType: 'image/jpeg', bytes: 1000, width: 800, height: 800, sha256: 'a'.repeat(64), status: 'READY' } })
      await testPrisma.romancePhoto.create({ data: { profileId: profile.id, assetId: asset.id, position: 0, blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' } })
      expect(await generateRomanceDropForUser(testPrisma, me.userId, now(), { force: true })).toMatchObject({ created: 1 })

      const res = await req(me.jar, 'GET', '/api/romance/drop')
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ modeLabel: ROMANCE_MODE_LABEL, active: true })
      const drop = res.data.drop
      expect(drop).toMatchObject({ status: 'NEW', candidate: { id: them.id } })
      expect(drop.reasons.length).toBeGreaterThan(0)
      expect(Object.keys(drop.candidate).sort()).toEqual(['builderRole', 'headline', 'id', 'level', 'name', 'photos', 'profile', 'proof', 'skills', 'tier', 'username'])
      expect(drop.candidate.photos).toEqual([{ id: expect.any(String), position: 0, blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', revealed: false }])
      const text = JSON.stringify(res.data)
      for (const secret of ['avatar.png', 'A private-ish bio', 'Pune', 'pune-', 'WOMAN', 'MAN"', 'interestedIn', 'ageMin', 'minEndorsements', 'scope', asset.key, 'image', 'birth']) {
        expect(text, secret).not.toContain(secret)
      }
      expect(drop.candidate.profile).toMatchObject({ direction: 'founder', rhythm: 'night-owl', obsessions: ['compilers'] })
      // First sight is counted once.
      await req(me.jar, 'GET', '/api/romance/drop')
      expect(await testPrisma.productEvent.count({ where: { userId: me.userId, name: 'romance_drop_viewed' } })).toBe(1)
      expect(res.data.nextDropAt === null || new Date(res.data.nextDropAt).getTime() > Date.now()).toBe(true)
    }, 90_000)

    it('passes on the drop, once, and refuses somebody else\'s', async () => {
      const me = await member('passer')
      const other = await member('other', 'DE')
      await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      await generateRomanceDropForUser(testPrisma, me.userId, now(), { force: true })
      await generateRomanceDropForUser(testPrisma, other.userId, now(), { force: true })
      const drop = (await req(me.jar, 'GET', '/api/romance/drop')).data.drop
      const theirs = (await req(other.jar, 'GET', '/api/romance/drop')).data.drop
      expect((await req(other.jar, 'POST', `/api/romance/drop/${drop.id}/pass`, {})).status).toBe(404)
      const passed = await req(me.jar, 'POST', `/api/romance/drop/${drop.id}/pass`, {})
      expect(passed.status).toBe(200)
      expect(passed.data).toEqual({ id: drop.id, status: 'PASSED' })
      expect((await req(me.jar, 'POST', `/api/romance/drop/${drop.id}/pass`, {})).data.status).toBe('PASSED')
      expect((await req(me.jar, 'GET', '/api/romance/drop')).data.drop.status).toBe('PASSED')
      expect(theirs.id).not.toBe(drop.id)
      await testPrisma.romanceDrop.update({ where: { id: theirs.id }, data: { status: 'SPARKED' } })
      expect((await req(other.jar, 'POST', `/api/romance/drop/${theirs.id}/pass`, {})).data.error.code).toBe('DROP_NOT_PENDING')
    }, 90_000)

    it('hides a person who blocked the viewer or left the mode since', async () => {
      const me = await member('hider')
      const them = await person({ gender: 'MAN', interestedIn: ['WOMAN'] })
      await generateRomanceDropForUser(testPrisma, me.userId, now(), { force: true })
      expect((await req(me.jar, 'GET', '/api/romance/drop')).data.drop.candidate.id).toBe(them.id)
      await testPrisma.block.create({ data: { blockerId: them.id, blockedId: me.userId } })
      expect((await req(me.jar, 'GET', '/api/romance/drop')).data.drop).toBeNull()
      await testPrisma.block.deleteMany({ where: { blockerId: them.id } })
      expect((await req(me.jar, 'GET', '/api/romance/drop')).data.drop.candidate.id).toBe(them.id)
      await testPrisma.romanceProfile.delete({ where: { userId: them.id } })
      expect((await req(me.jar, 'GET', '/api/romance/drop')).data.drop).toBeNull()
    }, 90_000)
  })
})
