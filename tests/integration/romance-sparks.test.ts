import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, nextOpener, removePeople } from './matching-fixtures'
import { giveEndorsers, makeRomancePerson, type RomanceFixtureOptions } from './romance-fixtures'
import { sendRomanceSpark } from '../../src/lib/romance/sparks'
import { runSparkDigest } from '../../src/lib/matching/spark-digest'
import { ROMANCE_MODE_LABEL } from '../../src/lib/romance/config'
import { MemoryRealtime } from '../../src/lib/infra/realtime.memory'
import { setRealtime } from '../../src/lib/infra/realtime'
import { SPARK_HOURLY_BURST } from '../../src/lib/matching/sparks'

const DAY_MS = 24 * 60 * 60 * 1000

// Romance sparks and matches: who can spark whom, in what order the refusals come, and what a match does and does not do.
describe('romance sparks and matches', () => {
  const suffix = uniqueSuffix()
  const tag = `rs${suffix}`
  const realtime = new MemoryRealtime()
  let worldCounter = 0

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    setRealtime(realtime)
  })
  afterAll(async () => {
    setRealtime(undefined)
    await testPrisma.notification.deleteMany({ where: { user: { username: { startsWith: tag.toLowerCase() } } } })
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { startsWith: tag } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  const woman = (over: RomanceFixtureOptions = {}) => makeRomancePerson({ tag, gender: 'WOMAN', interestedIn: ['MAN'], ...over })
  const man = (over: RomanceFixtureOptions = {}) => makeRomancePerson({ tag, gender: 'MAN', interestedIn: ['WOMAN'], ...over })
  const spark = (fromId: string, toId: string, over: { opener?: string; dropId?: string; enforced?: boolean; at?: Date } = {}) =>
    sendRomanceSpark(testPrisma, fromId, { toId, opener: over.opener ?? nextOpener(), dropId: over.dropId }, { enforced: over.enforced ?? false, now: over.at })
  const code = (result: Awaited<ReturnType<typeof spark>>) => (result.ok ? 'OK' : result.code)
  /** Shows `candidateId` to `userId` in a drop that is open for the week. */
  const show = (userId: string, candidateId: string, over: { status?: 'NEW' | 'PASSED'; expiresAt?: Date } = {}) =>
    testPrisma.romanceDrop.create({ data: { userId, candidateId, score: 70, weekKey: `2030-W${String(++worldCounter).padStart(2, '0')}x${suffix.slice(-4)}`, status: over.status ?? 'NEW', expiresAt: over.expiresAt ?? new Date(Date.now() + 3 * DAY_MS) } })
  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a])
  const romanceMatch = (a: string, b: string) => testPrisma.match.findFirst({ where: { userAId: pair(a, b)[0], userBId: pair(a, b)[1], connectionType: 'DATING' } })

  describe('what is refused, and in which words', () => {
    it('needs a signed-in user and a well-formed body', async () => {
      expect((await req(null, 'POST', '/api/romance/sparks', {})).status).toBe(401)
      expect((await req(null, 'GET', '/api/romance/sparks/received')).status).toBe(401)
      expect((await req(null, 'GET', '/api/romance/matches')).status).toBe(401)
      expect((await req(null, 'GET', '/api/romance/matches/x')).status).toBe(401)
      const me = await registerAndLogin(`${tag}.v@test.dev`, `${tag}v`)
      for (const body of [{}, { toId: 'x' }, { toId: 'x', opener: 5 }, { toId: '', opener: 'hello' }, { toId: 'x', opener: 'hello there', extra: 1 }, { toId: 'x', opener: 'hello there', connectionType: 'DATING' }]) {
        const res = await req(me.jar, 'POST', '/api/romance/sparks', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    }, 60_000)

    it('refuses sparking yourself, someone who does not exist and someone who is gone', async () => {
      const a = await woman()
      const gone = await man({ deleted: true })
      expect(code(await spark(a.id, a.id))).toBe('CANNOT_SPARK_SELF')
      expect(code(await spark(a.id, 'nobody'))).toBe('USER_NOT_FOUND')
      expect(code(await spark(a.id, gone.id))).toBe('USER_NOT_FOUND')
      expect(code(await spark('nobody', a.id))).toBe('USER_NOT_FOUND')
    }, 60_000)

    it('holds the sender to the gate: joined, 18 or older, verified, and a trusted account', async () => {
      const target = await man()
      const joinless = await woman({ romance: false })
      const noBirth = await woman({ birthDate: null })
      const minor = await woman({ birthDate: bornYearsAgo(17) })
      const dayShort = await woman({ birthDate: bornYearsAgo(18, -1) })
      const unverified = await woman({ emailVerified: false })
      const noContact = await woman({ phone: false, github: false })
      const fresh = await woman({ ageDays: 3 })
      expect(code(await spark(joinless.id, target.id))).toBe('ROMANCE_PROFILE_REQUIRED')
      expect(code(await spark(noBirth.id, target.id))).toBe('DATING_BIRTH_DATE_REQUIRED')
      expect(code(await spark(minor.id, target.id))).toBe('DATING_UNDERAGE')
      expect(code(await spark(dayShort.id, target.id))).toBe('DATING_UNDERAGE')
      expect(code(await spark(unverified.id, target.id))).toBe('DATING_VERIFICATION_REQUIRED')
      expect(code(await spark(noContact.id, target.id))).toBe('DATING_VERIFICATION_REQUIRED')
      expect(code(await spark(fresh.id, target.id))).toBe('ROMANCE_ACCOUNT_TOO_NEW')
      expect(await testPrisma.spark.count({ where: { toId: target.id } })).toBe(0)
    }, 120_000)

    it('names the mode in the words of a refusal, from the one constant', async () => {
      const target = await man()
      const minor = await woman({ birthDate: bornYearsAgo(17) })
      const result = await spark(minor.id, target.id)
      expect(result.ok).toBe(false)
      const { errorMessage } = await import('../../src/lib/api/errors')
      expect(errorMessage('DATING_UNDERAGE')).toContain(ROMANCE_MODE_LABEL)
      expect(errorMessage('ROMANCE_PROFILE_REQUIRED')).toBe(`Join ${ROMANCE_MODE_LABEL} first`)
      expect(errorMessage('ROMANCE_SPARK_LIMIT_REACHED', { limit: 3 })).toContain(`${ROMANCE_MODE_LABEL} sparks`)
    }, 60_000)

    it('treats everything that makes a person unavailable the same way, so none of it can be probed', async () => {
      const sender = await woman()
      const unavailable = [
        await man({ paused: true }),
        await man({ romance: false }),
        await man({ ageDays: 2 }),
        await man({ emailVerified: false }),
        await man({ birthDate: bornYearsAgo(17) }),
        await man({ phone: false, github: false }),
        await man({ interestedIn: ['MAN'] }), // does not want her
        await man({ ageMin: 40, ageMax: 60 }), // wants someone older
        await man({ gender: 'MAN', interestedIn: ['WOMAN'], scope: 'CITY', cityKey: `elsewhere-${suffix}`, countryCode: 'IN' }), // wants her in his city, she is not
        await man({ minEndorsements: 3 }), // asks for more builders vouching than she has
      ]
      for (const target of unavailable) await show(sender.id, target.id)
      for (const target of unavailable) expect(code(await spark(sender.id, target.id)), target.username).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(await testPrisma.spark.count({ where: { fromId: sender.id } })).toBe(0)
    }, 180_000)

    it('refuses a person the caller was never shown, whoever they are', async () => {
      const sender = await woman()
      const stranger = await man()
      const passed = await man()
      const expired = await man()
      await show(sender.id, passed.id, { status: 'PASSED' })
      await show(sender.id, expired.id, { expiresAt: new Date(Date.now() - 1000) })
      for (const target of [stranger, passed, expired]) expect(code(await spark(sender.id, target.id)), target.username).toBe('SPARK_TARGET_UNAVAILABLE')
    }, 90_000)

    it('refuses a blocker plainly and the blocked person as "not found"', async () => {
      const a = await woman()
      const b = await man()
      await show(a.id, b.id)
      await testPrisma.block.create({ data: { blockerId: a.id, blockedId: b.id } })
      expect(code(await spark(a.id, b.id))).toBe('USER_BLOCKED')
      expect(code(await spark(b.id, a.id))).toBe('USER_NOT_FOUND')
    }, 60_000)

    it('refuses an opener that is not a real reason to talk, and says why', async () => {
      const a = await woman()
      const b = await man()
      await show(a.id, b.id)
      const reasonOf = async (text: string) => {
        const result = await spark(a.id, b.id, { opener: text })
        return result.ok ? 'OK' : (result.details as { reason: string }).reason
      }
      expect(await reasonOf('Hi there')).toBe('TOO_SHORT')
      expect(await reasonOf('Check out my project at https://example.com/demo and tell me what you think')).toBe('LINK')
      expect(await reasonOf('Email me at someone@example.org about the project we discussed')).toBe('CONTACT_DETAILS')
      expect(await testPrisma.spark.count({ where: { fromId: a.id } })).toBe(0)
    }, 60_000)

    it('refuses a second spark to the same person, and a spark when there is a match or an ended one', async () => {
      const a = await woman()
      const b = await man()
      const c = await man()
      await show(a.id, b.id)
      await show(a.id, c.id)
      expect(code(await spark(a.id, b.id))).toBe('OK')
      expect(code(await spark(a.id, b.id))).toBe('SPARK_ALREADY_SENT')
      const [userAId, userBId] = pair(a.id, c.id)
      await testPrisma.match.create({ data: { userAId, userBId, userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COFOUNDER', endedAt: new Date(), endReason: 'UNMATCHED' } })
      expect(code(await spark(a.id, c.id))).toBe('MATCH_ENDED')
    }, 90_000)
  })

  describe('the inbox gate', () => {
    it('lets a sender with enough trusted endorsers in, and keeps out one with fewer', async () => {
      const gated = await man({ minEndorsements: 2 })
      const lacking = await woman()
      const vouched = await woman()
      await giveEndorsers(tag, vouched.id, 2)
      await show(lacking.id, gated.id)
      await show(vouched.id, gated.id)
      expect(code(await spark(lacking.id, gated.id))).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(code(await spark(vouched.id, gated.id))).toBe('OK')
    }, 120_000)

    it('does not stand in the way of a reply: somebody who already sparked you can be answered', async () => {
      const gated = await woman({ minEndorsements: 3 })
      const plain = await man()
      // The gated person was shown him and sparked first (his own gate is open); he, without three endorsers, answers.
      await show(gated.id, plain.id)
      expect(code(await spark(gated.id, plain.id))).toBe('OK')
      const answer = await spark(plain.id, gated.id)
      expect(answer.ok).toBe(true)
      expect(answer.ok && answer.match).not.toBeNull()
    }, 90_000)
  })

  describe('a match', () => {
    it('is made by the second spark: a conversation with the icebreaker and both openers, a notification each, and nothing public', async () => {
      const a = await woman({ obsessions: ['climate tech'], rhythm: 'night-owl' })
      const b = await man({ obsessions: ['climate tech'], rhythm: 'night-owl' })
      const aOpener = nextOpener()
      const bOpener = nextOpener()
      await show(a.id, b.id)
      await show(b.id, a.id)
      realtime.published.length = 0

      const first = await spark(a.id, b.id, { opener: aOpener })
      expect(first).toMatchObject({ ok: true, match: null })
      expect(await romanceMatch(a.id, b.id)).toBeNull()
      const second = await spark(b.id, a.id, { opener: bOpener })
      expect(second.ok).toBe(true)
      const match = (second as { match: NonNullable<Awaited<ReturnType<typeof romanceMatch>>> }).match
      const [userAId, userBId] = pair(a.id, b.id)
      expect(match).toMatchObject({ userAId, userBId, connectionType: 'DATING', userARole: 'DATING', userBRole: 'DATING', endedAt: null })
      expect((await testPrisma.spark.findMany({ where: { fromId: { in: [a.id, b.id] }, toId: { in: [a.id, b.id] } } })).map((s) => s.status)).toEqual(['MATCHED', 'MATCHED'])
      expect((await testPrisma.romanceDrop.findMany({ where: { userId: { in: [a.id, b.id] } } })).map((d) => d.status)).toEqual(['SPARKED', 'SPARKED'])

      const conversation = await testPrisma.conversation.findUniqueOrThrow({ where: { id: match.conversationId! }, include: { members: true, messages: { orderBy: { createdAt: 'asc' } } } })
      expect(conversation.messages.map((m) => m.type)).toEqual(['SYSTEM', 'TEXT', 'TEXT'])
      expect(conversation.messages[0].content.startsWith(`It is a ${ROMANCE_MODE_LABEL} match.`)).toBe(true)
      expect(conversation.messages[0].content).toContain("You're both night-owl builders obsessed with climate tech.")
      expect(conversation.messages[0].content).not.toMatch(/\b(she|he|her|his|him)\b/i)
      expect(conversation.messages.slice(1).map((m) => [m.senderId, m.content])).toEqual([[a.id, aOpener], [b.id, bOpener]])

      for (const me of [a, b]) {
        const notices = await testPrisma.notification.findMany({ where: { userId: me.id, type: 'MATCH' } })
        expect(notices).toHaveLength(1)
        expect(notices[0].title).toBe(`It is a ${ROMANCE_MODE_LABEL} match`)
        expect(realtime.published.filter((p) => p.channel === `user:${me.id}` && p.event === 'match.created')).toHaveLength(1)
        expect(await testPrisma.productEvent.count({ where: { userId: me.id, name: 'romance_match_created' } })).toBe(1)
        expect(await testPrisma.productEvent.count({ where: { userId: me.id, name: 'match_created' } })).toBe(0)
        // Nothing public: no XP, no counter, no achievement.
        expect((await testPrisma.user.findUniqueOrThrow({ where: { id: me.id } })).xp).toBe(0)
        expect(await testPrisma.xPEvent.count({ where: { userId: me.id } })).toBe(0)
        expect(await testPrisma.userCounter.count({ where: { userId: me.id, key: { in: ['matches', 'match_teams'] } } })).toBe(0)
        expect(await testPrisma.userAchievement.count({ where: { userId: me.id } })).toBe(0)
      }
    }, 120_000)

    it('makes exactly one match when two people spark each other at the same moment', async () => {
      const a = await woman()
      const b = await man()
      await show(a.id, b.id)
      await show(b.id, a.id)
      const results = await Promise.all([spark(a.id, b.id), spark(b.id, a.id)])
      expect(results.every((r) => r.ok)).toBe(true)
      expect(await testPrisma.match.count({ where: { userAId: pair(a.id, b.id)[0], userBId: pair(a.id, b.id)[1], connectionType: 'DATING' } })).toBe(1)
      expect(await testPrisma.message.count({ where: { conversationId: (await romanceMatch(a.id, b.id))!.conversationId! } })).toBe(3)
    }, 120_000)

    it('is never part of a professional surface, and does not count when the two form a team', async () => {
      const a = await registerAndLogin(`${tag}.pa@test.dev`, `${tag}pa`)
      const b = await registerAndLogin(`${tag}.pb@test.dev`, `${tag}pb`)
      for (const [u, gender, interestedIn] of [[a, 'WOMAN', ['MAN']], [b, 'MAN', ['WOMAN']]] as const) {
        await testPrisma.user.update({ where: { id: u.userId }, data: { isEmailVerified: true, isPhoneVerified: true, birthDate: new Date(`${bornYearsAgo(30)}T00:00:00Z`) } })
        await testPrisma.matchingProfile.create({ data: { userId: u.userId, connectionTypes: ['COFOUNDER'] } })
        await testPrisma.romanceProfile.create({
          data: { userId: u.userId, promptObsessed: 'x'.repeat(30), promptBuild: 'x'.repeat(30), promptWeekend: 'x'.repeat(30), ambition: 3, direction: 'founder', rhythm: 'steady', gender, interestedIn: [...interestedIn], ageMin: 18, ageMax: 99, scope: 'ANYWHERE' },
        })
      }
      await show(a.userId, b.userId)
      await show(b.userId, a.userId)
      expect((await spark(a.userId, b.userId)).ok).toBe(true)
      expect((await spark(b.userId, a.userId)).ok).toBe(true)
      expect(await romanceMatch(a.userId, b.userId)).not.toBeNull()

      // Not in the professional lists, received sparks or digest.
      expect((await req(a.jar, 'GET', '/api/matches')).data).toMatchObject({ matches: [], total: 0 })
      expect((await req(a.jar, 'GET', '/api/sparks/received')).data.count).toBe(0)
      // And the two forming a team is not "a match that became a team".
      const team = await req(a.jar, 'POST', '/api/teams', { name: `Romance Crew ${suffix}`, maxSize: 4 })
      const application = await req(b.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
      expect((await req(a.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${application.data.id}`, { status: 'ACCEPTED' })).status).toBe(200)
      for (const u of [a, b]) {
        expect(await testPrisma.userAchievement.count({ where: { userId: u.userId, achievement: { slug: { in: ['first-match', 'matches-10', 'match-teamed'] } } } })).toBe(0)
        expect(await testPrisma.userCounter.count({ where: { userId: u.userId, key: { in: ['matches', 'match_teams'] } } })).toBe(0)
      }
    }, 180_000)
  })

  describe('limits', () => {
    it('limits the sparks of a week, says how many, and counts the week in the sender\'s own zone', async () => {
      const a = await woman()
      const targets = []
      for (let i = 0; i < 5; i++) {
        const t = await man()
        await show(a.id, t.id)
        targets.push(t)
      }
      for (let i = 0; i < 3; i++) expect(code(await spark(a.id, targets[i].id))).toBe('OK')
      const fourth = await spark(a.id, targets[3].id)
      expect(fourth).toMatchObject({ ok: false, code: 'ROMANCE_SPARK_LIMIT_REACHED', params: { limit: 3, mode: ROMANCE_MODE_LABEL } })
      // A plan with room, once plans are on.
      await testPrisma.subscription.create({ data: { userId: a.id, plan: 'PRO', status: 'ACTIVE' } })
      expect(code(await spark(a.id, targets[3].id, { enforced: true }))).toBe('OK')
      expect(code(await spark(a.id, targets[4].id, { enforced: true }))).toBe('OK')
    }, 180_000)

    it('slows down a burst', async () => {
      const a = await woman()
      await testPrisma.subscription.create({ data: { userId: a.id, plan: 'PRO', status: 'ACTIVE' } })
      const targets = []
      for (let i = 0; i < SPARK_HOURLY_BURST + 1; i++) {
        const t = await man()
        await show(a.id, t.id)
        targets.push(t)
      }
      // PRO allows ten a week with plans on; the throttle is eight in an hour.
      for (let i = 0; i < SPARK_HOURLY_BURST; i++) expect(code(await spark(a.id, targets[i].id, { enforced: true }))).toBe('OK')
      expect(await spark(a.id, targets[SPARK_HOURLY_BURST].id, { enforced: true })).toMatchObject({ ok: false, code: 'SPARK_THROTTLED' })
    }, 240_000)
  })

  describe('telling people', () => {
    it('tells the person per spark with the sender (the mode named), when their plan shows who', async () => {
      const a = await woman()
      const b = await man()
      await show(a.id, b.id)
      expect((await spark(a.id, b.id)).ok).toBe(true)
      const notices = await testPrisma.notification.findMany({ where: { userId: b.id } })
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ type: 'SPARK', title: ROMANCE_MODE_LABEL })
      expect(notices[0].message).toContain(`sparked you in ${ROMANCE_MODE_LABEL}`)
      expect(notices[0].metadata).toMatchObject({ kind: 'ROMANCE_SPARK', fromId: a.id })
    }, 90_000)

    it('tells a plan that does not show who with one daily count, no names, kept apart from the professional count', async () => {
      const target = await man({ timezone: 'UTC' })
      const senders = []
      for (let i = 0; i < 2; i++) {
        const s = await woman()
        await show(s.id, target.id)
        expect((await spark(s.id, target.id, { enforced: true })).ok).toBe(true)
        senders.push(s)
      }
      expect(await testPrisma.notification.count({ where: { userId: target.id } })).toBe(0)
      const morning = new Date(`${new Date().toISOString().slice(0, 10)}T23:00:00Z`)
      const romance = await runSparkDigest(testPrisma, { enforced: true, now: morning, mode: 'romance' })
      expect(romance.notified).toBeGreaterThanOrEqual(1)
      const list = await testPrisma.notification.findMany({ where: { userId: target.id } })
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ type: 'SPARK', title: ROMANCE_MODE_LABEL, message: `2 people sparked you in ${ROMANCE_MODE_LABEL}` })
      expect(list[0].metadata).toMatchObject({ kind: 'ROMANCE_SPARK_DIGEST', count: 2 })
      for (const s of senders) expect(JSON.stringify(list[0])).not.toContain(s.id)
      // The professional digest counts none of them.
      await runSparkDigest(testPrisma, { enforced: true, now: new Date(morning.getTime() + 1000), mode: 'professional' })
      expect(await testPrisma.notification.count({ where: { userId: target.id } })).toBe(1)
    }, 180_000)
  })

  describe('the routes', () => {
    async function member(label: string, gender: 'WOMAN' | 'MAN', cityKey: string): Promise<TestUser> {
      const u = await registerAndLogin(`${tag}.${label}@test.dev`, `${tag}${label}`)
      await testPrisma.user.update({ where: { id: u.userId }, data: { isEmailVerified: true, isPhoneVerified: true, birthDate: new Date(`${bornYearsAgo(30)}T00:00:00Z`) } })
      await testPrisma.profile.create({ data: { userId: u.userId, countryCode: 'IN', cityKey, city: cityKey } })
      await testPrisma.romanceProfile.create({
        data: { userId: u.userId, promptObsessed: 'Compilers and the people who love them.', promptBuild: 'A tool I would use every day.', promptWeekend: 'Ship something small, then eat well.', ambition: 3, direction: 'founder', rhythm: 'night-owl', obsessions: ['compilers'], gender, interestedIn: [gender === 'WOMAN' ? 'MAN' : 'WOMAN'], ageMin: 18, ageMax: 99, scope: 'CITY' },
      })
      return u
    }

    it('sends a spark, makes the match on the answer, lists it, and leaves through the existing unmatch and report routes, silently', async () => {
      const city = `${tag}-routes`
      const a = await member('ra', 'WOMAN', city)
      const b = await member('rb', 'MAN', city)
      await show(a.userId, b.userId)
      await show(b.userId, a.userId)
      const opener = nextOpener()
      const first = await req(a.jar, 'POST', '/api/romance/sparks', { toId: b.userId, opener }, { 'Idempotency-Key': `rs-${suffix}-0001` })
      expect(first.status).toBe(201)
      expect(first.data).toMatchObject({ spark: { toId: b.userId, opener, status: 'PENDING' }, match: null })
      const repeat = await req(a.jar, 'POST', '/api/romance/sparks', { toId: b.userId, opener }, { 'Idempotency-Key': `rs-${suffix}-0001` })
      expect(repeat.data.spark.id).toBe(first.data.spark.id)
      expect(await testPrisma.spark.count({ where: { fromId: a.userId, toId: b.userId } })).toBe(1)

      const received = await req(b.jar, 'GET', '/api/romance/sparks/received')
      expect(received.status).toBe(200)
      expect(received.data).toMatchObject({ modeLabel: ROMANCE_MODE_LABEL, canSee: true, count: 1 })
      expect(received.data.sparks[0]).toMatchObject({ opener, from: { id: a.userId } })
      expect(JSON.stringify(received.data)).not.toMatch(/photos|image|WOMAN|interestedIn/)

      const second = await req(b.jar, 'POST', '/api/romance/sparks', { toId: a.userId, opener: nextOpener() })
      expect(second.status).toBe(201)
      expect(second.data.match).toMatchObject({ other: { id: a.userId } })
      expect(second.data.match.other.photos).toEqual([])

      const list = await req(a.jar, 'GET', '/api/romance/matches')
      expect(list.data).toMatchObject({ modeLabel: ROMANCE_MODE_LABEL, total: 1 })
      expect(list.data.matches[0]).toMatchObject({ id: second.data.match.id, other: { id: b.userId } })
      expect((await req(a.jar, 'GET', `/api/romance/matches/${second.data.match.id}`)).status).toBe(200)
      expect((await req(await member('rc', 'WOMAN', city).then((u) => u.jar), 'GET', `/api/romance/matches/${second.data.match.id}`)).status).toBe(404)

      // Leaving reuses the existing route and is silent.
      const before = await testPrisma.notification.count({ where: { userId: { in: [a.userId, b.userId] } } })
      realtime.published.length = 0
      const left = await req(a.jar, 'DELETE', `/api/matches/${second.data.match.id}`)
      expect(left.status).toBe(200)
      expect(await testPrisma.notification.count({ where: { userId: { in: [a.userId, b.userId] } } })).toBe(before)
      // (The push to the other person is checked against the in-process realtime in matching-notifications.test.ts; the server here has its own.)
      expect((await req(a.jar, 'GET', '/api/romance/matches')).data.total).toBe(0)
      expect((await req(a.jar, 'GET', `/api/romance/matches/${second.data.match.id}`)).status).toBe(404)
      // And it is final: the pair can never spark again.
      expect(code(await spark(a.userId, b.userId))).toBe('MATCH_ENDED')
    }, 240_000)

    it('reports and leaves through the existing route', async () => {
      const city = `${tag}-report`
      const a = await member('rd', 'WOMAN', city)
      const b = await member('re', 'MAN', city)
      await show(a.userId, b.userId)
      await show(b.userId, a.userId)
      await spark(a.userId, b.userId)
      const matched = await spark(b.userId, a.userId)
      const matchId = (matched as { match: { id: string } }).match.id
      const res = await req(a.jar, 'POST', `/api/matches/${matchId}/report`, { reason: 'HARASSMENT', description: 'Not ok.' })
      expect(res.status).toBe(201)
      expect(await testPrisma.report.count({ where: { reporterId: a.userId, reportedId: b.userId } })).toBe(1)
      expect((await testPrisma.match.findUniqueOrThrow({ where: { id: matchId } })).endReason).toBe('REPORTED')
    }, 180_000)
  })
})
