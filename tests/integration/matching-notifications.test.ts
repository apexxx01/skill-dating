import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { makePerson, nextOpener, removePeople, type FixtureOptions } from './matching-fixtures'
import { sendSpark } from '../../src/lib/matching/sparks'
import { runSparkDigest, digestMessage } from '../../src/lib/matching/spark-digest'
import { unmatch } from '../../src/lib/matching/matches'
import { MemoryRealtime } from '../../src/lib/infra/realtime.memory'
import { setRealtime } from '../../src/lib/infra/realtime'
import { jobs, runJob } from '../../src/lib/infra/jobs'

// Telling people they were sparked: each spark with its sender for a plan that shows who, one daily count (no names) for one that does not, both switchable;
// and a match, not an unmatch, is what the other person hears about.
describe('spark notifications', () => {
  const suffix = uniqueSuffix()
  const tag = `sn${suffix}`
  const realtime = new MemoryRealtime()

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
    await cleanupTestUsers(suffix)
  }, 180_000)

  const person = (options: Partial<FixtureOptions> = {}) => makePerson({ tag, ...options })
  const spark = (fromId: string, toId: string, enforced: boolean, at?: Date) =>
    sendSpark(testPrisma, fromId, { toId, connectionType: 'COFOUNDER', opener: nextOpener() }, { enforced, now: at })
  const notices = (userId: string) => testPrisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
  const makePro = (userId: string) => testPrisma.subscription.create({ data: { userId, plan: 'PRO', status: 'ACTIVE' } })

  describe('a plan that shows who sparked you', () => {
    it('is told about each spark as it is sent, with who sent it', async () => {
      const pro = await person()
      await makePro(pro.id)
      const a = await person()
      const b = await person()
      expect((await spark(a.id, pro.id, true)).ok).toBe(true)
      expect((await spark(b.id, pro.id, true)).ok).toBe(true)
      const list = await notices(pro.id)
      expect(list).toHaveLength(2)
      expect(list.map((n) => n.type)).toEqual(['SPARK', 'SPARK'])
      expect(list[0].message).toContain(`Person`)
      expect(list.map((n) => (n.metadata as { fromId: string }).fromId).sort()).toEqual([a.id, b.id].sort())
      expect(list[0].metadata).toMatchObject({ kind: 'SPARK', connectionType: 'COFOUNDER' })
    })

    it('is told by everyone while plans are not enforced, because every feature is open', async () => {
      const target = await person()
      const sender = await person()
      await spark(sender.id, target.id, false)
      expect(await notices(target.id)).toHaveLength(1)
      expect(await runSparkDigest(testPrisma, { enforced: false, now: new Date(Date.now() + 5 * 3_600_000) })).toBeDefined()
      expect(await notices(target.id)).toHaveLength(1)
    })

    it('is told nothing at all by a spark that makes a match: the match notification is the news', async () => {
      const pro = await person()
      await makePro(pro.id)
      const other = await person()
      await spark(pro.id, other.id, true)
      await spark(other.id, pro.id, true)
      // (A first match also earns an achievement, which is a notification of its own kind.)
      const about = async (userId: string) => (await notices(userId)).map((n) => n.type).filter((type) => type === 'MATCH' || type === 'SPARK')
      expect(await about(pro.id)).toEqual(['MATCH'])
      expect(await about(other.id)).toEqual(['MATCH'])
    })
  })

  describe('a plan that does not: one daily count, no names', () => {
    const MORNING_UTC = (day: string) => new Date(`${day}T10:00:00Z`)

    it('writes nothing when a spark is sent, then one notification a day with the count and nobody\'s name', async () => {
      const target = await person({ timezone: 'UTC' })
      const senders = [await person({ lookingForSkills: [] }), await person(), await person()]
      const at = new Date()
      for (const sender of senders) expect((await spark(sender.id, target.id, true, at)).ok).toBe(true)
      expect(await notices(target.id)).toEqual([])

      const result = await runSparkDigest(testPrisma, { enforced: true, now: new Date(Math.max(at.getTime(), new Date(`${at.toISOString().slice(0, 10)}T09:30:00Z`).getTime()) + 1000) })
      expect(result.notified).toBeGreaterThanOrEqual(1)
      const list = await notices(target.id)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ type: 'SPARK', title: 'New sparks', message: digestMessage(3), link: '/sparks' })
      expect(list[0].metadata).toMatchObject({ kind: 'SPARK_DIGEST', count: 3 })
      const text = JSON.stringify(list[0])
      for (const sender of senders) {
        expect(text).not.toContain(sender.id)
        expect(text).not.toContain(sender.username)
      }
    })

    it('sends it once a local day and counts only what came since', async () => {
      const target = await person({ timezone: 'UTC' })
      const a = await person()
      const b = await person()
      const day1 = MORNING_UTC('2031-03-10')
      await spark(a.id, target.id, true, new Date('2031-03-10T08:00:00Z'))
      const first = await runSparkDigest(testPrisma, { enforced: true, now: day1 })
      expect(first.notified).toBeGreaterThanOrEqual(1)
      // Again the same day: nothing new, even with a new spark.
      await spark(b.id, target.id, true, new Date('2031-03-10T10:30:00Z'))
      await runSparkDigest(testPrisma, { enforced: true, now: new Date('2031-03-10T11:00:00Z') })
      expect(await notices(target.id)).toHaveLength(1)
      expect((await notices(target.id))[0].message).toBe('1 person sparked you')
      // The next morning: just the one that came since.
      await runSparkDigest(testPrisma, { enforced: true, now: MORNING_UTC('2031-03-11') })
      const list = await notices(target.id)
      expect(list.map((n) => n.message)).toEqual(['1 person sparked you', '1 person sparked you'])
      // And a day with nothing new sends nothing.
      await runSparkDigest(testPrisma, { enforced: true, now: MORNING_UTC('2031-03-12') })
      expect(await notices(target.id)).toHaveLength(2)
    })

    it('waits for the morning of the person\'s own zone', async () => {
      const target = await person({ timezone: 'Asia/Kolkata' })
      const sender = await person()
      await spark(sender.id, target.id, true, new Date('2031-04-01T01:00:00Z'))
      // 03:00 UTC is 08:30 in Kolkata: too early. 03:30 UTC is 09:00 there.
      await runSparkDigest(testPrisma, { enforced: true, now: new Date('2031-04-01T03:00:00Z') })
      expect(await notices(target.id)).toHaveLength(0)
      await runSparkDigest(testPrisma, { enforced: true, now: new Date('2031-04-01T03:30:00Z') })
      expect(await notices(target.id)).toHaveLength(1)
    })

    it('does not count a sender who is blocked either way or gone, and sends nothing for no sparks', async () => {
      const target = await person({ timezone: 'UTC' })
      const kept = await person()
      const blocked = await person()
      const gone = await person()
      const at = new Date('2031-05-05T06:00:00Z')
      for (const sender of [kept, blocked, gone]) await spark(sender.id, target.id, true, at)
      await testPrisma.block.create({ data: { blockerId: target.id, blockedId: blocked.id } })
      await testPrisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
      await runSparkDigest(testPrisma, { enforced: true, now: new Date('2031-05-05T10:00:00Z') })
      expect((await notices(target.id)).map((n) => n.message)).toEqual(['1 person sparked you'])

      const lonely = await person({ timezone: 'UTC' })
      await runSparkDigest(testPrisma, { enforced: true, now: new Date('2031-05-05T10:00:00Z') })
      expect(await notices(lonely.id)).toEqual([])
    })

    it('respects the switches: a person who turned the count off gets none and is not asked again that day', async () => {
      const target = await person({ timezone: 'UTC' })
      const sender = await person()
      await testPrisma.notificationPreference.create({ data: { userId: target.id, kind: 'SPARK_DIGEST', enabled: false } })
      await spark(sender.id, target.id, true, new Date('2031-06-01T06:00:00Z'))
      await runSparkDigest(testPrisma, { enforced: true, now: new Date('2031-06-01T10:00:00Z') })
      expect(await notices(target.id)).toEqual([])
      expect((await testPrisma.matchingProfile.findUniqueOrThrow({ where: { userId: target.id } })).sparkDigestAt).not.toBeNull()
    })

    it('runs as a job', async () => {
      expect(jobs['sparks/digest'].schedule).toBe('35 * * * *')
      const result = (await runJob(jobs, 'sparks/digest', {})) as { considered: number }
      expect(typeof result.considered).toBe('number')
    })
  })

  describe('per-spark notifications can be switched off too', () => {
    it('writes none for a person who turned sparks off', async () => {
      const pro = await person()
      await makePro(pro.id)
      await testPrisma.notificationPreference.create({ data: { userId: pro.id, kind: 'SPARK', enabled: false } })
      const sender = await person()
      expect((await spark(sender.id, pro.id, true)).ok).toBe(true)
      expect(await notices(pro.id)).toEqual([])
    })
  })

  describe('unmatching is silent', () => {
    it('notifies the other person of nothing; the push removes the match from their screen', async () => {
      const a = await person()
      const b = await person()
      await spark(a.id, b.id, false)
      await spark(b.id, a.id, false)
      const match = await testPrisma.match.findFirstOrThrow({ where: { OR: [{ userAId: a.id, userBId: b.id }, { userAId: b.id, userBId: a.id }] } })
      const before = await testPrisma.notification.count({ where: { userId: { in: [a.id, b.id] } } })
      realtime.published.length = 0
      const outcome = await unmatch(testPrisma, a.id, match.id)
      expect(outcome.kind).toBe('ENDED')
      expect(await testPrisma.notification.count({ where: { userId: { in: [a.id, b.id] } } })).toBe(before)
      expect(realtime.published.filter((p) => p.channel === `user:${b.id}` && p.event === 'match.ended')).toHaveLength(1)
      expect(realtime.published.filter((p) => p.channel === `user:${a.id}`)).toHaveLength(0)
    })
  })

  describe('GET and PUT /api/notifications/preferences', () => {
    it('lists the kinds, all on, and saves what is switched', async () => {
      expect((await req(null, 'GET', '/api/notifications/preferences')).status).toBe(401)
      expect((await req(null, 'PUT', '/api/notifications/preferences', {})).status).toBe(401)
      const me = await registerAndLogin(`${tag}.prefs@test.dev`, `${tag}prefs`)
      const fresh = await req(me.jar, 'GET', '/api/notifications/preferences')
      expect(fresh.status).toBe(200)
      expect(fresh.data.preferences.map((p: { kind: string }) => p.kind)).toEqual(['SPARK', 'SPARK_DIGEST', 'ROMANCE_DROP'])
      expect(fresh.data.preferences.every((p: { enabled: boolean }) => p.enabled)).toBe(true)
      expect(fresh.data.preferences[0]).toMatchObject({ type: 'SPARK', label: expect.stringContaining('sparked') })

      const saved = await req(me.jar, 'PUT', '/api/notifications/preferences', { preferences: { SPARK_DIGEST: false } })
      expect(saved.status).toBe(200)
      expect(saved.data.preferences.find((p: { kind: string }) => p.kind === 'SPARK_DIGEST').enabled).toBe(false)
      expect(saved.data.preferences.find((p: { kind: string }) => p.kind === 'SPARK').enabled).toBe(true)
      // Switching back on, and a repeat changes nothing.
      await req(me.jar, 'PUT', '/api/notifications/preferences', { preferences: { SPARK_DIGEST: true } })
      const again = await req(me.jar, 'GET', '/api/notifications/preferences')
      expect(again.data.preferences.every((p: { enabled: boolean }) => p.enabled)).toBe(true)
      expect(await testPrisma.notificationPreference.count({ where: { userId: me.userId } })).toBe(1)
    }, 60_000)

    it('refuses an unknown kind, a non-boolean, nothing at all and unknown keys', async () => {
      const me = await registerAndLogin(`${tag}.prefs2@test.dev`, `${tag}prefs2`)
      for (const body of [{}, { preferences: {} }, { preferences: { NOPE: true } }, { preferences: { SPARK: 'yes' } }, { preferences: { SPARK: true }, extra: 1 }, { SPARK: true }]) {
        const res = await req(me.jar, 'PUT', '/api/notifications/preferences', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    }, 60_000)
  })
})
