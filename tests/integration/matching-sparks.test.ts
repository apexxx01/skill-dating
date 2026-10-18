import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, daysAgo, makePerson, makeSkills, removePeople, type FixtureOptions } from './matching-fixtures'
import { sendSpark, SPARK_HOURLY_BURST } from '../../src/lib/matching/sparks'
import { loadReceivedSparks } from '../../src/lib/matching/matches'
import { MemoryRealtime } from '../../src/lib/infra/realtime.memory'
import { setRealtime } from '../../src/lib/infra/realtime'
import type { MatchType } from '@prisma/client'

const DAY_MS = 24 * 60 * 60 * 1000

// A different, believable opener every time: a fixed frame around eight words that never repeat inside a run of ten, so no two of them are alike
// enough to be taken for the same message.
const WORDS = [
  'compiler', 'parser', 'graph', 'database', 'offline', 'sync', 'payments', 'robotics', 'firmware', 'climate', 'mapping', 'finals',
  'prototype', 'weekend', 'design', 'review', 'architecture', 'embedded', 'replication', 'kubernetes', 'tracing', 'latency', 'billing',
  'rendering', 'shaders', 'physics', 'audio', 'streaming', 'search', 'ranking', 'tokenizer', 'checkout', 'inventory', 'logistics',
  'drone', 'sensor', 'dashboard', 'onboarding', 'analytics', 'migration', 'sandbox', 'plugin', 'protocol', 'encryption', 'identity',
  'pipeline', 'scheduler', 'allocator', 'garbage', 'collector', 'bytecode', 'interpreter', 'typechecker', 'linter', 'formatter', 'editor',
  'keyboard', 'terminal', 'browser', 'extension', 'mobile', 'wearable', 'satellite', 'telescope', 'genome', 'protein', 'battery', 'solar',
]

describe('sparks and matches', () => {
  const suffix = uniqueSuffix()
  const tag = `sp${suffix}`
  let slugs: string[] = []
  let ml = ''
  let react = ''
  const realtime = new MemoryRealtime()
  let opener = 0
  const nextOpener = () => {
    const n = opener++
    const w = (k: number) => WORDS[(n * 8 + k) % WORDS.length]
    return `Your ${w(0)} ${w(1)} work caught my eye, and I am stuck on ${w(2)} ${w(3)} in my own build. Could we try a ${w(4)} ${w(5)} ${w(6)} ${w(7)} together this month?`
  }

  beforeAll(async () => {
    // The library code runs in this process (against the same database), so it needs the settings the application validates at start-up.
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    setRealtime(realtime)
    slugs = await makeSkills(tag, ['ml', 'react'])
    ;[ml, react] = slugs
  })
  afterAll(async () => {
    setRealtime(undefined)
    await testPrisma.notification.deleteMany({ where: { user: { username: { startsWith: tag.toLowerCase() } } } })
    await removePeople(tag)
    await testPrisma.skill.deleteMany({ where: { slug: { in: slugs } } })
    await cleanupTestUsers(suffix)
  }, 180_000)

  const person = (options: Partial<FixtureOptions> = {}) => makePerson({ tag, ...options })
  const spark = (fromId: string, toId: string, over: { connectionType?: MatchType; opener?: string; dropId?: string; enforced?: boolean; at?: Date } = {}) =>
    sendSpark(testPrisma, fromId, { toId, connectionType: over.connectionType ?? 'COFOUNDER', opener: over.opener ?? nextOpener(), dropId: over.dropId }, { enforced: over.enforced ?? false, now: over.at })
  const code = (result: Awaited<ReturnType<typeof spark>>) => (result.ok ? 'OK' : result.code)
  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a])
  const matchBetween = (a: string, b: string) => testPrisma.match.findFirst({ where: { userAId: pair(a, b)[0], userBId: pair(a, b)[1] } })

  describe('what is refused, and in which words', () => {
    it('needs a signed-in user and a well-formed body', async () => {
      expect((await req(null, 'POST', '/api/sparks', {})).status).toBe(401)
      expect((await req(null, 'GET', '/api/sparks/received')).status).toBe(401)
      expect((await req(null, 'GET', '/api/matches')).status).toBe(401)
      expect((await req(null, 'DELETE', '/api/matches/x')).status).toBe(401)
      expect((await req(null, 'POST', '/api/matches/x/report', {})).status).toBe(401)
      const me = await registerAndLogin(`${tag}.v@test.dev`, `${tag}v`)
      for (const body of [{}, { toId: 'x' }, { toId: 'x', connectionType: 'FRIEND', opener: 'hello there my friend' }, { toId: 'x', connectionType: 'COFOUNDER' }, { toId: 'x', connectionType: 'COFOUNDER', opener: 5 }, { toId: '', connectionType: 'COFOUNDER', opener: 'hello' }, { toId: 'x', connectionType: 'COFOUNDER', opener: 'a'.repeat(3000) }, { toId: 'x', connectionType: 'COFOUNDER', opener: 'hello there', extra: 1 }]) {
        const res = await req(me.jar, 'POST', '/api/sparks', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    })

    it('refuses sparking yourself, someone who does not exist and someone who is gone', async () => {
      const a = await person()
      const gone = await person({ deleted: true })
      expect(code(await spark(a.id, a.id))).toBe('CANNOT_SPARK_SELF')
      expect(code(await spark(a.id, 'nobody'))).toBe('USER_NOT_FOUND')
      expect(code(await spark(a.id, gone.id))).toBe('USER_NOT_FOUND')
      expect(code(await spark('nobody', a.id))).toBe('USER_NOT_FOUND')
    })

    it('needs the sender to have a profile that includes the type', async () => {
      const bare = await person({ profile: false })
      const mentee = await person({ types: ['MENTEE'] })
      const target = await person({ types: ['COFOUNDER', 'MENTOR'] })
      expect(code(await spark(bare.id, target.id))).toBe('MATCHING_PROFILE_REQUIRED')
      expect(code(await spark(mentee.id, target.id, { connectionType: 'COFOUNDER' }))).toBe('SPARK_TYPE_NOT_CHOSEN')
      expect(code(await spark(mentee.id, target.id, { connectionType: 'MENTEE' }))).toBe('OK')
    })

    it('treats everything that makes a person unavailable the same way', async () => {
      const sender = await person({ types: ['COFOUNDER'] })
      const cases = [
        await person({ paused: true }),
        await person({ types: ['COLLABORATOR'] }),
        await person({ profile: false }),
        await person({ ageDays: 2 }),
        await person({ emailVerified: false }),
      ]
      for (const target of cases) expect(code(await spark(sender.id, target.id)), target.username).toBe('SPARK_TARGET_UNAVAILABLE')
    })

    it('honours "only my city" from either side', async () => {
      const sender = await person({ cityOnly: true, cityKey: `pune-${suffix}` })
      const elsewhere = await person({ cityKey: `berlin-${suffix}` })
      const here = await person({ cityKey: `pune-${suffix}` })
      const picky = await person({ cityOnly: true, cityKey: `berlin-${suffix}` })
      const free = await person({ cityKey: `pune-${suffix}` })
      expect(code(await spark(sender.id, elsewhere.id))).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(code(await spark(sender.id, here.id))).toBe('OK')
      expect(code(await spark(free.id, picky.id))).toBe('SPARK_TARGET_UNAVAILABLE')
    })

    it('refuses a blocker plainly and the blocked person as "not found"', async () => {
      const a = await person()
      const b = await person()
      await testPrisma.block.create({ data: { blockerId: a.id, blockedId: b.id } })
      expect(code(await spark(a.id, b.id))).toBe('USER_BLOCKED')
      expect(code(await spark(b.id, a.id))).toBe('USER_NOT_FOUND')
    })

    it('refuses an opener that is not a real reason to talk, and says why', async () => {
      const a = await person()
      const b = await person()
      const reasonOf = async (text: string) => {
        const result = await spark(a.id, b.id, { opener: text })
        return result.ok ? 'OK' : (result.details as { reason: string }).reason
      }
      expect(await reasonOf('Hi there')).toBe('TOO_SHORT')
      expect(await reasonOf('x '.repeat(200))).toBe('TOO_LONG')
      expect(await reasonOf('Hey! Hey! Hey! Want to team up?')).toBe('LOW_EFFORT')
      expect(await reasonOf('Check out my project at https://example.com/demo and tell me what you think')).toBe('LINK')
      expect(await reasonOf('Email me at someone@example.org about the project we discussed')).toBe('CONTACT_DETAILS')
      expect(await reasonOf('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('REPEATED_CHARACTERS')
      const bad = await spark(a.id, b.id, { opener: 'Hi there' })
      expect(bad).toMatchObject({ ok: false, code: 'SPARK_OPENER_REJECTED' })
      expect(await testPrisma.spark.count({ where: { fromId: a.id } })).toBe(0)
    })

    it('refuses the same opener, or nearly, sent to someone else', async () => {
      const a = await person({ types: ['COFOUNDER', 'COLLABORATOR'] })
      const b = await person({ types: ['COFOUNDER', 'COLLABORATOR'] })
      const c = await person({ types: ['COFOUNDER', 'COLLABORATOR'] })
      const text = 'I loved your talk on event sourcing, I am building something similar for payments and need a second brain on it.'
      expect(code(await spark(a.id, b.id, { opener: text }))).toBe('OK')
      const again = await spark(a.id, c.id, { opener: text.toUpperCase() })
      expect(again).toMatchObject({ ok: false, code: 'SPARK_OPENER_REJECTED', details: { reason: 'DUPLICATE' } })
      const tweaked = await spark(a.id, c.id, { opener: text.replace('event sourcing', 'event streaming') })
      expect(tweaked).toMatchObject({ ok: false, details: { reason: 'DUPLICATE' } })
      // Another sender may use the same words, and a different message from the same sender is fine.
      expect(code(await spark(c.id, b.id, { opener: text }))).toBe('OK')
      expect(code(await spark(a.id, c.id))).toBe('OK')
      // An old repeat is forgotten.
      const old = await person()
      const target = await person()
      await testPrisma.spark.create({ data: { fromId: old.id, toId: (await person()).id, connectionType: 'COFOUNDER', opener: text, openerHash: 'old', createdAt: daysAgo(40) } })
      expect(code(await spark(old.id, target.id, { opener: text }))).toBe('OK')
    })

    it('refuses a second spark to the same person for the same type, and allows another type', async () => {
      const a = await person({ types: ['COFOUNDER', 'COLLABORATOR'] })
      const b = await person({ types: ['COFOUNDER', 'COLLABORATOR'] })
      expect(code(await spark(a.id, b.id))).toBe('OK')
      expect(code(await spark(a.id, b.id))).toBe('SPARK_ALREADY_SENT')
      expect(code(await spark(a.id, b.id, { connectionType: 'COLLABORATOR' }))).toBe('OK')
    })

    it('limits the sparks of a day to the plan, and says how many', async () => {
      const a = await person()
      const targets = []
      for (let i = 0; i < 7; i++) targets.push(await person())
      for (let i = 0; i < 5; i++) expect(code(await spark(a.id, targets[i].id, { enforced: true }))).toBe('OK')
      const sixth = await spark(a.id, targets[5].id, { enforced: true })
      expect(sixth).toMatchObject({ ok: false, code: 'SPARK_LIMIT_REACHED', params: { limit: 5 } })
      await testPrisma.subscription.create({ data: { userId: a.id, plan: 'PRO', status: 'ACTIVE' } })
      expect(code(await spark(a.id, targets[5].id, { enforced: true }))).toBe('OK')
      expect(code(await spark(a.id, targets[6].id, { enforced: true }))).toBe('OK')
    })

    it('counts the day in the sender’s own time zone', async () => {
      const a = await person({ timezone: 'Pacific/Kiritimati' })
      const targets = []
      for (let i = 0; i < 6; i++) targets.push(await person())
      // 12:00 UTC is 02:00 the next day in Kiritimati (UTC+14), whose day began at 10:00 UTC. Five sparks at 09:00 UTC are on the same UTC day but
      // the day before for the sender, so they do not count against today's allowance of five.
      const now = new Date('2030-03-05T12:00:00Z')
      for (let i = 0; i < 5; i++) {
        await testPrisma.spark.create({ data: { fromId: a.id, toId: targets[i].id, connectionType: 'COFOUNDER', opener: nextOpener(), openerHash: `h${i}${suffix}`, createdAt: new Date('2030-03-05T09:00:00Z') } })
      }
      expect(code(await spark(a.id, targets[5].id, { enforced: true, at: now }))).toBe('OK')
    })

    it('slows down somebody sending a burst', async () => {
      const a = await person()
      // A plan with room for more than the burst in a day (the free allowance is five), so it is the throttle that stops them.
      await testPrisma.subscription.create({ data: { userId: a.id, plan: 'PRO', status: 'ACTIVE' } })
      const targets = []
      for (let i = 0; i < SPARK_HOURLY_BURST + 1; i++) targets.push(await person())
      for (let i = 0; i < SPARK_HOURLY_BURST; i++) expect(code(await spark(a.id, targets[i].id, { enforced: true }))).toBe('OK')
      const next = await spark(a.id, targets[SPARK_HOURLY_BURST].id, { enforced: true })
      expect(next).toMatchObject({ ok: false, code: 'SPARK_THROTTLED' })
      expect((next as unknown as { params: { retryAfter: number } }).params.retryAfter).toBeGreaterThan(0)
      // An hour later the burst is over.
      expect(code(await spark(a.id, targets[SPARK_HOURLY_BURST].id, { at: new Date(Date.now() + 61 * 60_000) }))).toBe('OK')
    })

    it('only lets a spark answer the sender’s own open drop for that person', async () => {
      const a = await person()
      const b = await person()
      const c = await person()
      const expiresAt = new Date(Date.now() + DAY_MS)
      const mk = (userId: string, candidateId: string, over: Record<string, unknown> = {}) =>
        testPrisma.drop.create({ data: { userId, candidateId, connectionType: 'COFOUNDER', score: 60, localDate: '2030-01-01', expiresAt, ...over } })
      const mine = await mk(a.id, b.id)
      const forC = await mk(a.id, c.id)
      const theirs = await mk(c.id, b.id)
      const passed = await mk(a.id, c.id, { localDate: '2030-01-02', status: 'PASSED' })
      const expired = await mk(a.id, c.id, { localDate: '2030-01-03', expiresAt: daysAgo(1) })
      expect(code(await spark(a.id, b.id, { dropId: theirs.id }))).toBe('DROP_NOT_FOUND')
      expect(code(await spark(a.id, b.id, { dropId: forC.id }))).toBe('DROP_NOT_FOUND')
      expect(code(await spark(a.id, b.id, { dropId: 'nope' }))).toBe('DROP_NOT_FOUND')
      expect(code(await spark(a.id, c.id, { dropId: passed.id }))).toBe('DROP_NOT_PENDING')
      expect(code(await spark(a.id, c.id, { dropId: expired.id }))).toBe('DROP_NOT_PENDING')
      expect(code(await spark(a.id, b.id, { dropId: mine.id }))).toBe('OK')
      expect((await testPrisma.drop.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('SPARKED')
      expect((await testPrisma.spark.findFirstOrThrow({ where: { fromId: a.id, toId: b.id } })).dropId).toBe(mine.id)
    })
  })

  describe('dating', () => {
    const adult = bornYearsAgo(30)

    it('refuses a spark of type DATING from anyone who does not pass the gate', async () => {
      const target = await person({ types: ['DATING'], birthDate: adult, phone: true })
      const noDate = await person({ types: ['DATING'], birthDate: null, phone: true })
      const minor = await person({ types: ['DATING'], birthDate: bornYearsAgo(16), phone: true })
      const dayShort = await person({ types: ['DATING'], birthDate: bornYearsAgo(18, -1), phone: true })
      const unverified = await person({ types: ['DATING'], birthDate: adult, phone: true, emailVerified: false })
      const noContact = await person({ types: ['DATING'], birthDate: adult })
      expect(code(await spark(noDate.id, target.id, { connectionType: 'DATING' }))).toBe('DATING_BIRTH_DATE_REQUIRED')
      expect(code(await spark(minor.id, target.id, { connectionType: 'DATING' }))).toBe('DATING_UNDERAGE')
      expect(code(await spark(dayShort.id, target.id, { connectionType: 'DATING' }))).toBe('DATING_UNDERAGE')
      expect(code(await spark(unverified.id, target.id, { connectionType: 'DATING' }))).toBe('DATING_VERIFICATION_REQUIRED')
      expect(code(await spark(noContact.id, target.id, { connectionType: 'DATING' }))).toBe('DATING_VERIFICATION_REQUIRED')
      expect(await testPrisma.spark.count({ where: { toId: target.id } })).toBe(0)
    })

    it('refuses sparking a person who is not dating-eligible, whatever they chose', async () => {
      const sender = await person({ types: ['DATING'], birthDate: adult, phone: true })
      const minorTarget = await person({ types: ['DATING'], birthDate: bornYearsAgo(17), phone: true })
      const noGithubTarget = await person({ types: ['DATING'], birthDate: adult })
      const adultTarget = await person({ types: ['DATING'], birthDate: adult, github: true })
      expect(code(await spark(sender.id, minorTarget.id, { connectionType: 'DATING' }))).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(code(await spark(sender.id, noGithubTarget.id, { connectionType: 'DATING' }))).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(code(await spark(sender.id, adultTarget.id, { connectionType: 'DATING' }))).toBe('OK')
    })

    it('never crosses dating with another type, in either direction', async () => {
      const datingOnly = await person({ types: ['DATING'], birthDate: adult, phone: true })
      const cofounderOnly = await person({ types: ['COFOUNDER'], birthDate: adult, phone: true })
      const both = await person({ types: ['COFOUNDER', 'DATING'], birthDate: adult, phone: true })
      expect(code(await spark(cofounderOnly.id, datingOnly.id, { connectionType: 'COFOUNDER' }))).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(code(await spark(datingOnly.id, cofounderOnly.id, { connectionType: 'DATING' }))).toBe('SPARK_TARGET_UNAVAILABLE')
      expect(code(await spark(datingOnly.id, cofounderOnly.id, { connectionType: 'COFOUNDER' }))).toBe('SPARK_TYPE_NOT_CHOSEN')
      expect(code(await spark(cofounderOnly.id, cofounderOnly.id, { connectionType: 'DATING' }))).toBe('CANNOT_SPARK_SELF')
      expect(code(await spark(cofounderOnly.id, both.id, { connectionType: 'DATING' }))).toBe('SPARK_TYPE_NOT_CHOSEN')
      // A dating spark and a cofounder spark between the same two people are different pairs: answering one type with the other makes no match.
      expect(code(await spark(both.id, cofounderOnly.id, { connectionType: 'COFOUNDER' }))).toBe('OK')
      expect(code(await spark(cofounderOnly.id, both.id, { connectionType: 'COFOUNDER' }))).toBe('OK')
      expect((await matchBetween(both.id, cofounderOnly.id))?.connectionType).toBe('COFOUNDER')
      expect(code(await spark(both.id, datingOnly.id, { connectionType: 'DATING' }))).toBe('OK')
      expect(code(await spark(datingOnly.id, both.id, { connectionType: 'DATING' }))).toBe('OK')
      expect((await matchBetween(both.id, datingOnly.id))?.connectionType).toBe('DATING')
    })

    it('does not pair a dating spark with a spark of another type', async () => {
      const a = await person({ types: ['DATING', 'COLLABORATOR'], birthDate: adult, phone: true })
      const b = await person({ types: ['DATING', 'COLLABORATOR'], birthDate: adult, phone: true })
      expect(code(await spark(a.id, b.id, { connectionType: 'DATING' }))).toBe('OK')
      const answer = await spark(b.id, a.id, { connectionType: 'COLLABORATOR' })
      expect(answer.ok && answer.match).toBe(null)
      expect(await matchBetween(a.id, b.id)).toBeNull()
    })
  })

  describe('a match', () => {
    it('is made by the second spark: a conversation with the icebreaker and both openers, a notification each, and no XP', async () => {
      const a = await person({ lookingForSkills: [ml], skills: [[react, 4]], intentTags: [{ tag: 'ship-by-year-end' }], techStack: ['react', 'postgres'] })
      const b = await person({ lookingForSkills: [react], skills: [[ml, 5]], intentTags: [{ tag: 'ship-by-year-end' }], techStack: ['postgres'] })
      const aOpener = nextOpener()
      const bOpener = nextOpener()
      realtime.published.length = 0

      const first = await spark(a.id, b.id, { opener: aOpener })
      expect(first).toMatchObject({ ok: true, match: null })
      expect((first as { spark: { status: string } }).spark.status).toBe('PENDING')
      expect(await matchBetween(a.id, b.id)).toBeNull()

      const second = await spark(b.id, a.id, { opener: bOpener })
      expect(second.ok).toBe(true)
      const match = (second as { match: NonNullable<Awaited<ReturnType<typeof matchBetween>>> }).match
      expect(match).toBeTruthy()
      const [userAId, userBId] = pair(a.id, b.id)
      expect(match).toMatchObject({ userAId, userBId, connectionType: 'COFOUNDER', userARole: 'COFOUNDER', userBRole: 'COFOUNDER', endedAt: null })
      expect(match.conversationId).toBeTruthy()

      // Both sparks are matched.
      expect((await testPrisma.spark.findMany({ where: { fromId: { in: [a.id, b.id] }, toId: { in: [a.id, b.id] } } })).map((s) => s.status)).toEqual(['MATCHED', 'MATCHED'])

      // The conversation: two members, the system icebreaker first, then the openers in the order they were written.
      const conversation = await testPrisma.conversation.findUniqueOrThrow({ where: { id: match.conversationId! }, include: { members: true, messages: { orderBy: { createdAt: 'asc' } } } })
      expect(conversation).toMatchObject({ type: 'DIRECT', closedAt: null })
      expect(conversation.members.map((m) => m.userId).sort()).toEqual([a.id, b.id].sort())
      expect(conversation.messages.map((m) => m.type)).toEqual(['SYSTEM', 'TEXT', 'TEXT'])
      expect(conversation.messages[0].content).toContain('It is a match')
      expect(conversation.messages[0].content).toContain('Both want to ship by year end.')
      expect(conversation.messages[0].content).toContain('You both build with postgres.')
      expect(conversation.messages[0].content).not.toMatch(/\b(she|he|her|his|him)\b/i)
      expect(conversation.messages.slice(1).map((m) => [m.senderId, m.content])).toEqual([[a.id, aOpener], [b.id, bOpener]])

      // A notification for each, a push for each, and a count of each event.
      for (const [me, them] of [[a, b], [b, a]] as const) {
        const notices = await testPrisma.notification.findMany({ where: { userId: me.id, type: 'MATCH' } })
        expect(notices).toHaveLength(1)
        expect(notices[0].metadata).toMatchObject({ matchId: match.id, conversationId: match.conversationId })
        expect(notices[0].message).toContain('sparked each other')
        expect(realtime.published.filter((p) => p.channel === `user:${me.id}` && p.event === 'match.created')).toHaveLength(1)
        expect(await testPrisma.productEvent.count({ where: { userId: me.id, name: 'match_created' } })).toBe(1)
        expect(them.id).toBeTruthy()
      }
      expect(await testPrisma.productEvent.count({ where: { userId: a.id, name: 'spark_sent' } })).toBe(1)
      expect(await testPrisma.productEvent.count({ where: { userId: b.id, name: 'spark_sent' } })).toBe(1)

      // No XP from the sparks or the match themselves; the first-match achievement pays its one-off 25 and nothing else is paid.
      for (const person of [a, b]) {
        expect((await testPrisma.user.findUniqueOrThrow({ where: { id: person.id } })).xp).toBe(25)
        const paid = await testPrisma.xPEvent.findMany({ where: { userId: person.id } })
        expect(paid.map((row) => [row.type, row.sourceId, row.amount])).toEqual([['ACHIEVEMENT_EARNED', 'first-match', 25]])
        expect(await testPrisma.userAchievement.count({ where: { userId: person.id, achievement: { slug: 'first-match' } } })).toBe(1)
        expect((await testPrisma.userCounter.findFirstOrThrow({ where: { userId: person.id, key: 'matches' } })).value).toBe(1)
      }
    })

    it('stores the pair once, smaller id first, whoever sparked first', async () => {
      const x = await person()
      const y = await person()
      const [low, high] = pair(x.id, y.id)
      const sparker = low === x.id ? y : x
      const answerer = low === x.id ? x : y
      await spark(sparker.id, answerer.id)
      await spark(answerer.id, sparker.id)
      const rows = await testPrisma.match.findMany({ where: { userAId: low, userBId: high } })
      expect(rows).toHaveLength(1)
      expect(rows[0].userAId < rows[0].userBId).toBe(true)
    })

    it('pairs a mentee with a mentor, under the name of the relationship, with each one’s role', async () => {
      const mentee = await person({ types: ['MENTEE'] })
      const mentor = await person({ types: ['MENTOR'] })
      expect(code(await spark(mentee.id, mentor.id, { connectionType: 'MENTEE' }))).toBe('OK')
      const answer = await spark(mentor.id, mentee.id, { connectionType: 'MENTOR' })
      expect(answer.ok).toBe(true)
      const match = (await matchBetween(mentee.id, mentor.id))!
      expect(match.connectionType).toBe('MENTOR')
      const roles = new Map([[match.userAId, match.userARole], [match.userBId, match.userBRole]])
      expect(roles.get(mentee.id)).toBe('MENTEE')
      expect(roles.get(mentor.id)).toBe('MENTOR')
      const conversation = await testPrisma.message.findFirstOrThrow({ where: { conversationId: match.conversationId!, type: 'SYSTEM' } })
      expect(conversation.content).toContain('a mentor and a mentee')
    })

    it('does not pair two sparks that are not each other’s counterpart', async () => {
      const a = await person({ types: ['COFOUNDER', 'COLLABORATOR', 'MENTEE', 'MENTOR'] })
      const b = await person({ types: ['COFOUNDER', 'COLLABORATOR', 'MENTEE', 'MENTOR'] })
      await spark(a.id, b.id, { connectionType: 'COFOUNDER' })
      expect((await spark(b.id, a.id, { connectionType: 'COLLABORATOR' })) as { match: unknown }).toMatchObject({ match: null })
      await spark(a.id, b.id, { connectionType: 'MENTEE' })
      expect((await spark(b.id, a.id, { connectionType: 'MENTEE' })) as { match: unknown }).toMatchObject({ match: null })
      expect(await matchBetween(a.id, b.id)).toBeNull()
      // Answering the mentee spark as a mentor does match.
      const answer = await spark(b.id, a.id, { connectionType: 'MENTOR' })
      expect((answer as { match: { connectionType: string } }).match.connectionType).toBe('MENTOR')
    })

    it('makes exactly one match when two people spark each other at the same moment', async () => {
      for (let round = 0; round < 3; round++) {
        const a = await person()
        const b = await person()
        const results = await Promise.all([spark(a.id, b.id), spark(b.id, a.id)])
        expect(results.every((r) => r.ok)).toBe(true)
        expect(results.filter((r) => r.ok && r.match !== null)).toHaveLength(1)
        const rows = await testPrisma.match.findMany({ where: { userAId: pair(a.id, b.id)[0], userBId: pair(a.id, b.id)[1] } })
        expect(rows).toHaveLength(1)
        expect(await testPrisma.message.count({ where: { conversationId: rows[0].conversationId! } })).toBe(3)
        expect(await testPrisma.conversation.count({ where: { type: 'DIRECT', members: { every: { userId: { in: [a.id, b.id] } } } } })).toBe(1)
        expect((await testPrisma.spark.findMany({ where: { fromId: { in: [a.id, b.id] } } })).every((s) => s.status === 'MATCHED')).toBe(true)
        expect(await testPrisma.userAchievement.count({ where: { userId: a.id, achievement: { slug: 'first-match' } } })).toBe(1)
      }
    })

    it('uses the direct conversation the two already had, and answers the drops that showed them to each other', async () => {
      const a = await person()
      const b = await person()
      const existing = await testPrisma.conversation.create({ data: { type: 'DIRECT', members: { create: [{ userId: a.id }, { userId: b.id }] } } })
      const expiresAt = new Date(Date.now() + DAY_MS)
      const dropAB = await testPrisma.drop.create({ data: { userId: a.id, candidateId: b.id, connectionType: 'COFOUNDER', score: 70, localDate: '2030-02-01', expiresAt } })
      const dropBA = await testPrisma.drop.create({ data: { userId: b.id, candidateId: a.id, connectionType: 'COFOUNDER', score: 70, localDate: '2030-02-01', expiresAt } })
      await spark(a.id, b.id, { dropId: dropAB.id })
      await spark(b.id, a.id)
      const match = (await matchBetween(a.id, b.id))!
      expect(match.conversationId).toBe(existing.id)
      expect((await testPrisma.drop.findUniqueOrThrow({ where: { id: dropAB.id } })).status).toBe('SPARKED')
      expect((await testPrisma.drop.findUniqueOrThrow({ where: { id: dropBA.id } })).status).toBe('SPARKED')
    })

    it('is protected by the database too: the pair is ordered and an opener has a real length', async () => {
      const x = await person()
      const y = await person()
      const [low, high] = pair(x.id, y.id)
      await expect(testPrisma.match.create({ data: { userAId: high, userBId: low, userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COFOUNDER' } })).rejects.toThrow()
      await expect(testPrisma.spark.create({ data: { fromId: x.id, toId: y.id, connectionType: 'COFOUNDER', opener: 'too short', openerHash: 'x' } })).rejects.toThrow()
      await testPrisma.match.create({ data: { userAId: low, userBId: high, userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COFOUNDER' } })
      await expect(testPrisma.match.create({ data: { userAId: low, userBId: high, userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COFOUNDER' } })).rejects.toThrow()
    })

    it('counts toward the match achievements for each person only when the other is a trusted account', async () => {
      const a = await person()
      const b = await person()
      await spark(a.id, b.id)
      // b stops being a trusted account (the email check lapses) before answering. a is still trusted, so b's match counts; a's does not.
      await testPrisma.user.update({ where: { id: b.id }, data: { isEmailVerified: false } })
      const answer = await spark(b.id, a.id)
      expect(answer.ok && answer.match).toBeTruthy()
      expect(await testPrisma.userAchievement.count({ where: { userId: b.id, achievement: { slug: 'first-match' } } })).toBe(1)
      expect(await testPrisma.userAchievement.count({ where: { userId: a.id, achievement: { slug: 'first-match' } } })).toBe(0)
      // The match itself exists for both: only what it counts toward is withheld.
      expect(await matchBetween(a.id, b.id)).not.toBeNull()
    })
  })

  describe('after a match, over HTTP', () => {
    let alice: TestUser
    let bob: TestUser
    let carol: TestUser
    let aliceCarolMatch = ''

    beforeAll(async () => {
      alice = await registerAndLogin(`${tag}.alice@test.dev`, `${tag}alice`)
      bob = await registerAndLogin(`${tag}.bob@test.dev`, `${tag}bob`)
      carol = await registerAndLogin(`${tag}.carol@test.dev`, `${tag}carol`)
      for (const [u, types] of [[alice, ['COFOUNDER', 'COLLABORATOR']], [bob, ['COFOUNDER', 'COLLABORATOR']], [carol, ['COFOUNDER', 'COLLABORATOR']]] as const) {
        await testPrisma.matchingProfile.create({ data: { userId: u.userId, connectionTypes: [...types] as MatchType[] } })
      }
    }, 120_000)

    const sparkVia = (u: TestUser, toId: string, over: Record<string, unknown> = {}) => req(u.jar, 'POST', '/api/sparks', { toId, connectionType: 'COFOUNDER', opener: nextOpener(), ...over })

    it('sends a spark, answers a duplicate with a clear error, and returns the match on the answer', async () => {
      const first = await sparkVia(alice, carol.userId)
      expect(first.status).toBe(201)
      expect(first.data.match).toBeNull()
      expect(first.data.spark).toMatchObject({ toId: carol.userId, connectionType: 'COFOUNDER', status: 'PENDING' })
      expect(Object.keys(first.data.spark).sort()).toEqual(['connectionType', 'createdAt', 'id', 'opener', 'status', 'toId'])
      const dup = await sparkVia(alice, carol.userId)
      expect(dup.status).toBe(409)
      expect(dup.data.error.code).toBe('SPARK_ALREADY_SENT')

      const answer = await sparkVia(carol, alice.userId)
      expect(answer.status).toBe(201)
      expect(answer.data.match).toMatchObject({ connectionType: 'COFOUNDER', yourRole: 'COFOUNDER', theirRole: 'COFOUNDER', other: { id: alice.userId, username: `${tag}alice` } })
      expect(answer.data.match.conversationId).toBeTruthy()
      aliceCarolMatch = answer.data.match.id
      expect(JSON.stringify(answer.data)).not.toMatch(/email|birthDate|@test\.dev/i)
    })

    it('refuses an opener with its reason in the error', async () => {
      const res = await sparkVia(alice, bob.userId, { opener: 'hey whats up' })
      expect(res.status).toBe(400)
      expect(res.data.error.code).toBe('SPARK_OPENER_REJECTED')
      expect(res.data.error.details.reason).toBeTruthy()
      expect(res.data.error.details.message).toEqual(expect.any(String))
    })

    it('honours an Idempotency-Key: a retry returns the first response and sends one spark', async () => {
      const key = `spark-${suffix}-idem-000`
      const body = { toId: bob.userId, connectionType: 'COLLABORATOR', opener: nextOpener() }
      const a = await req(alice.jar, 'POST', '/api/sparks', body, { 'Idempotency-Key': key })
      const b = await req(alice.jar, 'POST', '/api/sparks', body, { 'Idempotency-Key': key })
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      expect(b.data.spark.id).toBe(a.data.spark.id)
      expect(await testPrisma.spark.count({ where: { fromId: alice.userId, toId: bob.userId, connectionType: 'COLLABORATOR' } })).toBe(1)
    })

    it('lists the caller’s open matches with the other person’s card, newest first, with cursors', async () => {
      const res = await req(alice.jar, 'GET', '/api/matches')
      expect(res.status).toBe(200)
      expect(res.data.total).toBeGreaterThanOrEqual(1)
      const mine = res.data.matches.find((m: { id: string }) => m.id === aliceCarolMatch)
      expect(mine).toMatchObject({ connectionType: 'COFOUNDER', other: { id: carol.userId } })
      expect(Object.keys(mine.other).sort()).toEqual(['builderRole', 'headline', 'id', 'image', 'level', 'location', 'name', 'proof', 'skills', 'tier', 'username'])
      const times = res.data.matches.map((m: { createdAt: string }) => m.createdAt)
      expect(times).toEqual([...times].sort().reverse())
      // A cursor walks the same list.
      const extra = await person({ types: ['COFOUNDER'] })
      await testPrisma.matchingProfile.update({ where: { userId: alice.userId }, data: { connectionTypes: ['COFOUNDER', 'COLLABORATOR'] } })
      await spark(extra.id, alice.userId)
      await sparkVia(alice, extra.id)
      const one = await req(alice.jar, 'GET', '/api/matches?limit=1')
      expect(one.data.matches).toHaveLength(1)
      expect(one.data.nextCursor).toEqual(expect.any(String))
      const two = await req(alice.jar, 'GET', `/api/matches?limit=1&cursor=${encodeURIComponent(one.data.nextCursor)}`)
      expect(two.data.matches[0].id).not.toBe(one.data.matches[0].id)
      expect((await req(alice.jar, 'GET', '/api/matches?cursor=garbage')).data.error.code).toBe('INVALID_CURSOR')
      expect((await req(alice.jar, 'GET', '/api/matches?limit=500')).status).toBe(400)
    })

    it('shows the sparks received to a caller with the entitlement, and only the number without it', async () => {
      const sender = await person({ skills: [[ml, 3]] })
      const senderOpener = nextOpener()
      expect(code(await spark(sender.id, bob.userId, { opener: senderOpener }))).toBe('OK')
      const res = await req(bob.jar, 'GET', '/api/sparks/received')
      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({ canSee: true, count: expect.any(Number) })
      const item = res.data.sparks.find((s: { from: { id: string } }) => s.from.id === sender.id)
      expect(item).toMatchObject({ connectionType: 'COFOUNDER', opener: senderOpener })
      expect(Object.keys(item).sort()).toEqual(['connectionType', 'createdAt', 'from', 'id', 'opener'])

      // Without SEE_WHO_SPARKED (plan limits on): the count and nothing else.
      const gated = await loadReceivedSparks(testPrisma, bob.userId, { limit: 20, enforced: true })
      expect(gated).toEqual({ canSee: false, count: res.data.count, sparks: [], nextCursor: null })
      await testPrisma.subscription.create({ data: { userId: bob.userId, plan: 'PRO', status: 'ACTIVE' } })
      const paid = await loadReceivedSparks(testPrisma, bob.userId, { limit: 20, enforced: true })
      expect(paid).toMatchObject({ canSee: true })
      await testPrisma.subscription.delete({ where: { userId: bob.userId } })
    })

    it('does not count or show sparks from people who are blocked, either way, or gone', async () => {
      const blocker = await person()
      const blockedByMe = await person()
      const gone = await person()
      for (const p of [blocker, blockedByMe, gone]) await spark(p.id, carol.userId, { opener: nextOpener() })
      const before = (await req(carol.jar, 'GET', '/api/sparks/received')).data
      await testPrisma.block.create({ data: { blockerId: blocker.id, blockedId: carol.userId } })
      await testPrisma.block.create({ data: { blockerId: carol.userId, blockedId: blockedByMe.id } })
      await testPrisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
      const after = (await req(carol.jar, 'GET', '/api/sparks/received')).data
      expect(after.count).toBe(before.count - 3)
      const ids = after.sparks.map((s: { from: { id: string } }) => s.from.id)
      for (const hidden of [blocker, blockedByMe, gone]) expect(ids).not.toContain(hidden.id)
      expect((await req(carol.jar, 'GET', '/api/sparks/received?limit=0')).status).toBe(400)
      expect((await req(carol.jar, 'GET', '/api/sparks/received?cursor=garbage')).data.error.code).toBe('INVALID_CURSOR')
    })

    it('unmatches for good: the conversation closes for both, the match leaves the list, and the pair cannot start again', async () => {
      const bobCarol = await sparkVia(bob, carol.userId)
      expect(bobCarol.status, JSON.stringify(bobCarol.data)).toBe(201)
      const answer = await sparkVia(carol, bob.userId)
      expect(answer.status, JSON.stringify(answer.data)).toBe(201)
      const matchId = answer.data.match.id
      const conversationId = answer.data.match.conversationId

      expect((await req(bob.jar, 'POST', `/api/conversations/${conversationId}`, { content: 'hello there' })).status).toBe(201)
      const stranger = await req(alice.jar, 'DELETE', `/api/matches/${matchId}`)
      expect(stranger.status).toBe(404)
      expect(stranger.data.error.code).toBe('MATCH_NOT_FOUND')
      expect((await testPrisma.match.findUniqueOrThrow({ where: { id: matchId } })).endedAt).toBeNull()

      const gone = await req(carol.jar, 'DELETE', `/api/matches/${matchId}`)
      expect(gone.status).toBe(200)
      expect(gone.data).toMatchObject({ id: matchId, endedAt: expect.any(String) })
      const row = await testPrisma.match.findUniqueOrThrow({ where: { id: matchId } })
      expect(row).toMatchObject({ endedById: carol.userId, endReason: 'UNMATCHED' })
      expect((await testPrisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).closedAt).not.toBeNull()
      expect(await testPrisma.productEvent.count({ where: { userId: carol.userId, name: 'unmatch' } })).toBe(1)

      // Closed for both; readable.
      for (const u of [bob, carol]) {
        const post = await req(u.jar, 'POST', `/api/conversations/${conversationId}`, { content: 'are you there?' })
        expect(post.status).toBe(409)
        expect(post.data.error.code).toBe('CONVERSATION_CLOSED')
        const read = await req(u.jar, 'GET', `/api/conversations/${conversationId}`)
        expect(read.status).toBe(200)
        expect(read.data.conversation.closedAt).toEqual(expect.any(String))
      }

      // Gone from both lists; doing it again answers the same; final for the pair.
      for (const u of [bob, carol]) expect((await req(u.jar, 'GET', '/api/matches')).data.matches.map((m: { id: string }) => m.id)).not.toContain(matchId)
      const again = await req(carol.jar, 'DELETE', `/api/matches/${matchId}`)
      expect(again.status).toBe(200)
      expect(again.data.endedAt).toBe(gone.data.endedAt)
      expect(await testPrisma.productEvent.count({ where: { userId: carol.userId, name: 'unmatch' } })).toBe(1)
      const restart = await sparkVia(bob, carol.userId, { connectionType: 'COLLABORATOR' })
      expect(restart.status).toBe(409)
      expect(restart.data.error.code).toBe('MATCH_ENDED')
    })

    it('tells the other person, and counts the unmatch once, when a match is ended', async () => {
      const { unmatch } = await import('../../src/lib/matching/matches')
      const a = await person()
      const b = await person()
      await spark(a.id, b.id)
      await spark(b.id, a.id)
      const match = (await matchBetween(a.id, b.id))!
      realtime.published.length = 0
      const first = await unmatch(testPrisma, a.id, match.id)
      expect(first).toMatchObject({ kind: 'ENDED', alreadyEnded: false })
      expect(realtime.published.filter((p) => p.event === 'match.ended').map((p) => p.channel)).toEqual([`user:${b.id}`])
      expect(await unmatch(testPrisma, b.id, match.id)).toMatchObject({ kind: 'ENDED', alreadyEnded: true })
      expect(realtime.published.filter((p) => p.event === 'match.ended')).toHaveLength(1)
      expect(await testPrisma.productEvent.count({ where: { userId: a.id, name: 'unmatch' } })).toBe(1)
      expect(await testPrisma.productEvent.count({ where: { userId: b.id, name: 'unmatch' } })).toBe(0)
      expect(await unmatch(testPrisma, 'nobody', match.id)).toEqual({ kind: 'NOT_FOUND' })
    })

    it('keeps an unmatched pair out of each other’s drops for good', async () => {
      const { generateDropsForUser } = await import('../../src/lib/matching/drops')
      const a = await person({ lookingForSkills: [ml] })
      const b = await person({ skills: [[ml, 5]] })
      await spark(a.id, b.id)
      await spark(b.id, a.id)
      const match = (await matchBetween(a.id, b.id))!
      await generateDropsForUser(testPrisma, a.id, new Date(), { enforced: false, force: true })
      expect((await testPrisma.drop.findMany({ where: { userId: a.id } })).map((d) => d.candidateId)).not.toContain(b.id)
      await testPrisma.match.update({ where: { id: match.id }, data: { endedAt: new Date(), endReason: 'UNMATCHED' } })
      await testPrisma.drop.deleteMany({ where: { userId: a.id } })
      await generateDropsForUser(testPrisma, a.id, new Date(Date.now() + 8 * DAY_MS), { enforced: false, force: true })
      expect((await testPrisma.drop.findMany({ where: { userId: a.id } })).map((d) => d.candidateId)).not.toContain(b.id)
    })

    it('keeps somebody already sparked out of the sender’s drops', async () => {
      const { generateDropsForUser } = await import('../../src/lib/matching/drops')
      const a = await person({ lookingForSkills: [ml] })
      const b = await person({ skills: [[ml, 5]] })
      await spark(a.id, b.id)
      await generateDropsForUser(testPrisma, a.id, new Date(), { enforced: false, force: true })
      expect((await testPrisma.drop.findMany({ where: { userId: a.id } })).map((d) => d.candidateId)).not.toContain(b.id)
    })

    it('unmatches and reports in one call, filing the report in the usual queue', async () => {
      const d = await registerAndLogin(`${tag}.dee@test.dev`, `${tag}dee`)
      const e = await registerAndLogin(`${tag}.eve@test.dev`, `${tag}eve`)
      for (const u of [d, e]) await testPrisma.matchingProfile.create({ data: { userId: u.userId, connectionTypes: ['COFOUNDER'] } })
      await sparkVia(d, e.userId)
      const matched = await sparkVia(e, d.userId)
      const matchId = matched.data.match.id
      const conversationId = matched.data.match.conversationId

      expect((await req(d.jar, 'POST', `/api/matches/${matchId}/report`, { reason: 'NOPE' })).status).toBe(400)
      expect((await req(d.jar, 'POST', `/api/matches/${matchId}/report`, {})).status).toBe(400)
      expect((await req(carol.jar, 'POST', `/api/matches/${matchId}/report`, { reason: 'SPAM' })).status).toBe(404)
      expect((await req(d.jar, 'POST', '/api/matches/nope/report', { reason: 'SPAM' })).status).toBe(404)
      expect((await testPrisma.match.findUniqueOrThrow({ where: { id: matchId } })).endedAt).toBeNull()

      const res = await req(d.jar, 'POST', `/api/matches/${matchId}/report`, { reason: 'HARASSMENT', description: 'They asked for my number' })
      expect(res.status).toBe(201)
      expect(res.data).toMatchObject({ matchId, endedAt: expect.any(String), report: { id: expect.any(String) }, alreadyReported: false })
      const report = await testPrisma.report.findUniqueOrThrow({ where: { id: res.data.report.id } })
      expect(report).toMatchObject({ reporterId: d.userId, reportedId: e.userId, reason: 'HARASSMENT', status: 'PENDING', description: 'They asked for my number' })
      expect(report.metadata).toMatchObject({ source: 'MATCH', matchId })
      expect(await testPrisma.auditEvent.count({ where: { userId: d.userId, action: 'REPORT_CREATED', targetId: report.id } })).toBe(1)
      expect(await testPrisma.match.findUniqueOrThrow({ where: { id: matchId } })).toMatchObject({ endReason: 'REPORTED', endedById: d.userId })
      expect((await testPrisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).closedAt).not.toBeNull()
      expect((await req(e.jar, 'POST', `/api/conversations/${conversationId}`, { content: 'hello' })).data.error.code).toBe('CONVERSATION_CLOSED')

      // Again: nothing doubled. The existing pending report is kept.
      const second = await req(d.jar, 'POST', `/api/matches/${matchId}/report`, { reason: 'SPAM' })
      expect(second.status).toBe(201)
      expect(second.data).toMatchObject({ alreadyReported: true, report: { id: report.id } })
      expect(await testPrisma.report.count({ where: { reporterId: d.userId, reportedId: e.userId } })).toBe(1)
      // The usual report queue sees it (moderators list it with the others).
      const admin = await registerAndLogin(`${tag}.admin@test.dev`, `${tag}admin`)
      await testPrisma.user.update({ where: { id: admin.userId }, data: { role: 'ADMIN' } })
      const queue = await req(admin.jar, 'GET', '/api/reports?status=PENDING&limit=50')
      expect(queue.status).toBe(200)
      expect(JSON.stringify(queue.data)).toContain(report.id)
    })

    it('ends a match, and closes its conversation, when one person blocks the other', async () => {
      const f = await registerAndLogin(`${tag}.fay@test.dev`, `${tag}fay`)
      const g = await registerAndLogin(`${tag}.gus@test.dev`, `${tag}gus`)
      for (const u of [f, g]) await testPrisma.matchingProfile.create({ data: { userId: u.userId, connectionTypes: ['COFOUNDER'] } })
      await sparkVia(f, g.userId)
      const matched = await sparkVia(g, f.userId)
      const blocked = await req(f.jar, 'POST', '/api/blocks', { userId: g.userId })
      expect(blocked.status).toBe(201)
      expect(blocked.data.endedMatches).toBe(1)
      expect(await testPrisma.match.findUniqueOrThrow({ where: { id: matched.data.match.id } })).toMatchObject({ endReason: 'BLOCKED', endedById: f.userId })
      expect((await testPrisma.conversation.findUniqueOrThrow({ where: { id: matched.data.match.conversationId } })).closedAt).not.toBeNull()
      for (const u of [f, g]) expect((await req(u.jar, 'GET', '/api/matches')).data.matches.map((m: { id: string }) => m.id)).not.toContain(matched.data.match.id)
    })

    it('hides a match from its list while one of the two is blocked', async () => {
      const i = await person()
      // A block written behind the application's back (as an older one would be) still hides the match.
      await testPrisma.block.create({ data: { blockerId: alice.userId, blockedId: i.id } })
      await testPrisma.match.create({ data: { userAId: pair(alice.userId, i.id)[0], userBId: pair(alice.userId, i.id)[1], userARole: 'COFOUNDER', userBRole: 'COFOUNDER', connectionType: 'COLLABORATOR' } })
      expect((await req(alice.jar, 'GET', '/api/matches')).data.matches.map((m: { other: { id: string } }) => m.other.id)).not.toContain(i.id)
    })
  })

  describe('a match that becomes a team', () => {
    it('counts toward the match-to-team achievement for both, once, and pays its one-off 100 XP', async () => {
      const lead = await registerAndLogin(`${tag}.lead@test.dev`, `${tag}lead`)
      const joiner = await registerAndLogin(`${tag}.joiner@test.dev`, `${tag}joiner`)
      const stranger = await registerAndLogin(`${tag}.stranger@test.dev`, `${tag}stranger`)
      for (const u of [lead, joiner, stranger]) await testPrisma.matchingProfile.create({ data: { userId: u.userId, connectionTypes: ['COFOUNDER'] } })
      await spark(lead.userId, joiner.userId)
      await spark(joiner.userId, lead.userId)

      const team = await req(lead.jar, 'POST', '/api/teams', { name: `Matched Crew ${suffix}`, maxSize: 4 })
      expect(team.status).toBe(201)
      // Somebody they did not match with joins first: nothing for the match.
      const strangerApplication = await req(stranger.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
      await req(lead.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${strangerApplication.data.id}`, { status: 'ACCEPTED' })
      expect(await testPrisma.userAchievement.count({ where: { userId: lead.userId, achievement: { slug: 'match-teamed' } } })).toBe(0)

      const application = await req(joiner.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
      expect(application.status).toBe(201)
      const accepted = await req(lead.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${application.data.id}`, { status: 'ACCEPTED' })
      expect(accepted.status).toBe(200)
      for (const u of [lead, joiner]) {
        expect(await testPrisma.userAchievement.count({ where: { userId: u.userId, achievement: { slug: 'match-teamed' } } })).toBe(1)
        expect((await testPrisma.userCounter.findFirstOrThrow({ where: { userId: u.userId, key: 'match_teams' } })).value).toBe(1)
        // The achievement pays once, 100 XP; the match that came before it paid its own 25 for first-match.
        const teamed = await testPrisma.xPEvent.findMany({ where: { userId: u.userId, type: 'ACHIEVEMENT_EARNED', sourceId: 'match-teamed' } })
        expect(teamed.map((row) => row.amount)).toEqual([100])
      }
    })

    it('counts nothing when the match had already ended', async () => {
      const lead = await registerAndLogin(`${tag}.lead2@test.dev`, `${tag}lead2`)
      const joiner = await registerAndLogin(`${tag}.joiner2@test.dev`, `${tag}joiner2`)
      for (const u of [lead, joiner]) await testPrisma.matchingProfile.create({ data: { userId: u.userId, connectionTypes: ['COFOUNDER'] } })
      await spark(lead.userId, joiner.userId)
      await spark(joiner.userId, lead.userId)
      const match = (await matchBetween(lead.userId, joiner.userId))!
      await testPrisma.match.update({ where: { id: match.id }, data: { endedAt: new Date(), endReason: 'UNMATCHED' } })
      const team = await req(lead.jar, 'POST', '/api/teams', { name: `Ended Crew ${suffix}`, maxSize: 4 })
      const application = await req(joiner.jar, 'POST', `/api/teams/${team.data.id}/applications`, {})
      await req(lead.jar, 'PATCH', `/api/teams/${team.data.id}/applications/${application.data.id}`, { status: 'ACCEPTED' })
      expect(await testPrisma.userAchievement.count({ where: { userId: lead.userId, achievement: { slug: 'match-teamed' } } })).toBe(0)
    })
  })

  describe('ten matches', () => {
    it('unlock the ten-matches achievement, which pays 25 for the first and 50 for the tenth and nothing for the matches in between', async () => {
      const hub = await person({ types: ['COLLABORATOR'] })
      // Ten sparks in a day is more than the free allowance, so the hub is on a plan that has room.
      await testPrisma.subscription.create({ data: { userId: hub.id, plan: 'PRO', status: 'ACTIVE' } })
      for (let i = 0; i < 10; i++) {
        const other = await person({ types: ['COLLABORATOR'] })
        const first = await spark(hub.id, other.id, { connectionType: 'COLLABORATOR', enforced: true, at: new Date(Date.now() - (11 - i) * 61 * 60_000) })
        const second = await spark(other.id, hub.id, { connectionType: 'COLLABORATOR' })
        expect([code(first), code(second)], `round ${i}`).toEqual(['OK', 'OK'])
      }
      expect(await testPrisma.match.count({ where: { OR: [{ userAId: hub.id }, { userBId: hub.id }] } })).toBe(10)
      expect((await testPrisma.userCounter.findFirstOrThrow({ where: { userId: hub.id, key: 'matches' } })).value).toBe(10)
      const earned = (await testPrisma.userAchievement.findMany({ where: { userId: hub.id }, select: { achievement: { select: { slug: true } } } })).map((row) => row.achievement.slug).sort()
      expect(earned).toEqual(['first-match', 'matches-10'])
      const paid = await testPrisma.xPEvent.findMany({ where: { userId: hub.id }, orderBy: { amount: 'asc' } })
      expect(paid.map((row) => [row.type, row.sourceId, row.amount])).toEqual([['ACHIEVEMENT_EARNED', 'first-match', 25], ['ACHIEVEMENT_EARNED', 'matches-10', 50]])
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: hub.id } })).xp).toBe(75)
    })
  })
})
