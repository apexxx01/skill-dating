import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest'
import { cleanupTestUsers, testPrisma } from './db'
import { uniqueSuffix } from './helpers'
import { INTEGRATION_DATABASE_URL } from './config'
import { makePerson, removePeople, type FixtureOptions } from './matching-fixtures'
import { MemoryEmail } from '../../src/lib/infra/email.memory'
import { MemoryPush } from '../../src/lib/infra/push.memory'
import { runDigests, sendDigest } from '../../src/lib/notify/digest'
import type { DispatchDeps } from '../../src/lib/notify/dispatch'
import { saveSettings, suppressAddress } from '../../src/lib/notify/settings'
import { readUnsubscribeToken } from '../../src/lib/notify/tokens'
import { invalidateFlags } from '../../src/lib/flags'

// The daily and weekly digests against a real database: who gets one, when, what is in it, and when it is not sent at all.
describe('notification digests', () => {
  const suffix = uniqueSuffix()
  const tag = `dg${suffix}`
  const THURSDAY = new Date('2026-10-22T10:30:00Z')
  const MONDAY = new Date('2026-10-26T10:00:00Z')
  let email: MemoryEmail
  const deps = (now: Date): DispatchDeps => ({ email, push: new MemoryPush(), baseUrl: 'https://app.test', now })
  const hackathons: string[] = []
  const recaps: string[] = []

  beforeAll(() => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  beforeEach(() => {
    email = new MemoryEmail()
  })
  afterAll(async () => {
    await testPrisma.hackathon.deleteMany({ where: { id: { in: hackathons } } })
    await testPrisma.shipDayRecap.deleteMany({ where: { id: { in: recaps } } })
    await removePeople(tag)
    await testPrisma.emailSuppression.deleteMany({ where: { email: { contains: tag } } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  /** A person who was here today and has a drop time of 09:00. The marketing consent is not needed: a digest is account mail. */
  async function reader(options: Partial<FixtureOptions> & { consent?: boolean } = {}) {
    const { consent = false, ...rest } = options
    const person = await makePerson({ tag, timezone: 'UTC', dropTimeLocal: '09:00', ...rest })
    if (consent) await testPrisma.consentRecord.create({ data: { userId: person.id, type: 'MARKETING', version: '2026-10-01', source: 'settings' } })
    return person
  }
  const sender = (type: 'COFOUNDER' | 'DATING' = 'COFOUNDER', over: Partial<FixtureOptions> = {}) => makePerson({ tag, profile: false, ...over }).then((person) => ({ ...person, type }))
  const spark = (fromId: string, toId: string, connectionType: 'COFOUNDER' | 'DATING' = 'COFOUNDER', at: Date = new Date(THURSDAY.getTime() - 3600_000)) =>
    testPrisma.spark.create({ data: { fromId, toId, connectionType, opener: `opener ${fromId}`.padEnd(30, 'x'), openerHash: `h${fromId}${toId}${connectionType}`, createdAt: at } })
  const drop = (userId: string, candidateId: string, localDate = '2026-10-22') =>
    testPrisma.drop.create({ data: { userId, candidateId, connectionType: 'COFOUNDER', score: 70, localDate, status: 'NEW', expiresAt: new Date(`${localDate}T23:59:00Z`) } })
  const addressOf = async (userId: string) => (await testPrisma.user.findUniqueOrThrow({ where: { id: userId } })).email
  const dailyOutcome = (userId: string, now = THURSDAY) => sendDigest(testPrisma, deps(now), 'DIGEST_DAILY', userId, now)
  const weeklyOutcome = (userId: string, now = MONDAY) => sendDigest(testPrisma, deps(now), 'DIGEST_WEEKLY', userId, now)

  describe('the daily digest', () => {
    it('is not sent when nothing is waiting, and does not use up the day', async () => {
      const a = await reader()
      expect(await dailyOutcome(a.id)).toBe('NOTHING_TO_SEND')
      expect(email.outbox).toHaveLength(0)
      expect(await testPrisma.notificationDelivery.count({ where: { userId: a.id } })).toBe(0)
      // Later the same day a drop arrives: now it is worth sending.
      const b = await sender()
      await drop(a.id, b.id)
      expect(await dailyOutcome(a.id, new Date('2026-10-22T14:00:00Z'))).toBe('SENT')
    })

    it('counts today’s Drops and the people who sparked, as numbers, with the unsubscribe headers and tracked links', async () => {
      const a = await reader()
      const [b, c, d] = await Promise.all([sender(), sender(), sender()])
      await drop(a.id, b.id)
      await drop(a.id, c.id)
      await spark(b.id, a.id)
      await spark(c.id, a.id)
      await spark(d.id, a.id)
      expect(await dailyOutcome(a.id)).toBe('SENT')
      const [mail] = email.to(await addressOf(a.id))
      expect(mail.subject).toBe('2 things are waiting for you today')
      expect(mail.html).toContain('2 people picked for you today')
      expect(mail.html).toContain('3 people sparked you')
      for (const other of [b, c, d]) expect(mail.html + mail.text).not.toContain(other.username)
      expect(mail.html).toContain('https://app.test/api/notifications/open/')
      expect(mail.html).not.toContain('href="https://app.test/discover"')
      expect(readUnsubscribeToken(new URL(mail.headers!['List-Unsubscribe'].slice(1, -1)).searchParams.get('t')!)).toEqual({ userId: a.id, kind: 'DIGEST_DAILY' })
      expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
      expect(mail.html).toContain('you chose to receive the daily digest')
      const settings = await testPrisma.notificationSettings.findUniqueOrThrow({ where: { userId: a.id } })
      expect(settings.lastDailyDigestAt).toEqual(THURSDAY)
      expect(await testPrisma.notificationDelivery.findFirst({ where: { userId: a.id } })).toMatchObject({ kind: 'DIGEST_DAILY', channel: 'EMAIL', status: 'SENT', dedupeKey: 'digest:2026-10-22', notificationId: null })
    })

    it('is sent once a local day', async () => {
      const a = await reader()
      const b = await sender()
      await drop(a.id, b.id)
      expect(await dailyOutcome(a.id)).toBe('SENT')
      expect(await dailyOutcome(a.id, new Date(THURSDAY.getTime() + 3600_000))).toBe('NOT_DUE')
      expect(email.outbox).toHaveLength(1)
      const tomorrow = new Date('2026-10-23T10:30:00Z')
      await drop(a.id, b.id, '2026-10-23')
      expect(await dailyOutcome(a.id, tomorrow)).toBe('SENT')
    })

    it('waits for an hour after the person’s drop time, in their own zone', async () => {
      const a = await reader({ timezone: 'Asia/Kolkata', dropTimeLocal: '09:00' })
      const b = await sender()
      // 04:00 UTC is 09:30 in Kolkata: the drops are there, the digest is not due until 10:00.
      await drop(a.id, b.id, '2026-10-22')
      expect(await dailyOutcome(a.id, new Date('2026-10-22T04:00:00Z'))).toBe('NOT_DUE')
      expect(await dailyOutcome(a.id, new Date('2026-10-22T04:35:00Z'))).toBe('SENT')
    })

    it('never counts the romance mode’s sparks, however many there are', async () => {
      const a = await reader()
      const b = await sender('DATING')
      await spark(b.id, a.id, 'DATING')
      expect(await dailyOutcome(a.id)).toBe('NOTHING_TO_SEND')
      const c = await sender()
      await spark(c.id, a.id)
      expect(await dailyOutcome(a.id)).toBe('SENT')
      expect(email.outbox[0].html).toContain('1 person sparked you')
      expect(email.outbox[0].html + email.outbox[0].text).not.toMatch(/romance|dating|private/i)
    })

    it('leaves out sparks from people the reader blocked, and from deleted accounts', async () => {
      const a = await reader()
      const blocked = await sender()
      const gone = await sender('COFOUNDER', { deleted: true })
      await testPrisma.block.create({ data: { blockerId: a.id, blockedId: blocked.id } })
      await spark(blocked.id, a.id)
      await spark(gone.id, a.id)
      expect(await dailyOutcome(a.id)).toBe('NOTHING_TO_SEND')
    })

    it('reminds a registrant with no squad that registration is closing, and a squad that its submission is due', async () => {
      const a = await reader()
      const b = await reader()
      const open = await testPrisma.hackathon.create({
        data: { name: `Closing ${tag}`, slug: `closing-${tag}`, description: 'x', startDate: new Date('2026-10-30T00:00:00Z'), endDate: new Date('2026-11-01T00:00:00Z'), registrationDeadline: new Date('2026-10-24T10:30:00Z'), status: 'UPCOMING' },
      })
      const running = await testPrisma.hackathon.create({
        data: { name: `Running ${tag}`, slug: `running-${tag}`, description: 'x', startDate: new Date('2026-10-20T00:00:00Z'), endDate: new Date('2026-10-23T12:30:00Z'), status: 'ACTIVE' },
      })
      hackathons.push(open.id, running.id)
      await testPrisma.hackathonParticipant.create({ data: { userId: a.id, hackathonId: open.id } })
      const team = await testPrisma.team.create({ data: { name: `Squad ${tag}`, slug: `squad-${tag}`, ownerId: b.id, hackathonId: running.id } })
      await testPrisma.hackathonParticipant.create({ data: { userId: b.id, hackathonId: running.id, status: 'TEAM_FORMED', teamId: team.id } })

      expect(await dailyOutcome(a.id)).toBe('SENT')
      expect(email.to(await addressOf(a.id))[0].html).toContain(`Closing ${tag}: registration closes in 2 days. You do not have a squad yet.`)
      expect(await dailyOutcome(b.id)).toBe('SENT')
      expect(email.to(await addressOf(b.id))[0].html).toContain(`Running ${tag}: your squad’s submission is due in 26 hours.`)
    })

    it('puts the open quests in only beside something worth sending', async () => {
      // Quests are paused for the whole suite (tests/integration/global-setup.ts); this test switches them on for itself.
      await testPrisma.featureFlag.update({ where: { key: 'quests' }, data: { enabled: true } })
      await invalidateFlags()
      try {
        const a = await reader()
        expect(await dailyOutcome(a.id)).toBe('NOTHING_TO_SEND')
        const b = await sender()
        await drop(a.id, b.id)
        await dailyOutcome(a.id)
        const html = email.outbox[0].html
        expect(html).toContain('<h2>Quests</h2>')
        expect(html).toMatch(/\d daily quests? (is|are) still open and reset at midnight/)
      } finally {
        await testPrisma.featureFlag.update({ where: { key: 'quests' }, data: { enabled: false } })
        await invalidateFlags()
      }
    })
  })

  describe('who gets one', () => {
    it('does not need the marketing consent, and is not stopped by withdrawing it: it is account mail, on by default', async () => {
      const without = await reader()
      const b = await sender()
      await drop(without.id, b.id)
      expect(await dailyOutcome(without.id)).toBe('SENT')

      const withdrawn = await reader({ consent: true })
      await drop(withdrawn.id, b.id)
      await testPrisma.consentRecord.updateMany({ where: { userId: withdrawn.id, type: 'MARKETING' }, data: { withdrawnAt: new Date() } })
      expect(await dailyOutcome(withdrawn.id)).toBe('SENT')
      expect(email.outbox).toHaveLength(2)
    })

    it('needs the digest and email switches on', async () => {
      const b = await sender()
      const noDaily = await reader()
      const noEmail = await reader()
      await drop(noDaily.id, b.id)
      await drop(noEmail.id, b.id)
      await saveSettings(testPrisma, noDaily.id, { dailyDigest: false })
      await saveSettings(testPrisma, noEmail.id, { emailEnabled: false })
      expect(await dailyOutcome(noDaily.id)).toBe('NOT_ELIGIBLE')
      expect(await dailyOutcome(noEmail.id)).toBe('NOT_ELIGIBLE')
      // The weekly one has its own switch: turning off the daily one leaves it.
      expect(await weeklyOutcome(noDaily.id)).not.toBe('NOT_ELIGIBLE')
    })

    it('skips a bounced address, an unverified one, a deleted account and someone who has not been here in two months', async () => {
      const b = await sender()
      const bounced = await reader()
      const unverified = await reader({ emailVerified: false })
      const deleted = await reader({ deleted: true })
      const dormant = await reader({ lastActiveDaysAgo: 61 })
      for (const person of [bounced, unverified, deleted, dormant]) await drop(person.id, b.id)
      await suppressAddress(testPrisma, await addressOf(bounced.id), 'BOUNCE')
      for (const person of [bounced, unverified, deleted, dormant]) expect(await dailyOutcome(person.id), person.username).toBe('NOT_ELIGIBLE')
      expect(email.outbox).toHaveLength(0)
    })

    it('is found by the hourly run among the people who are eligible, and not the ones who turned it off', async () => {
      const yes = await reader()
      const off = await reader()
      const b = await sender()
      await drop(yes.id, b.id)
      await drop(off.id, b.id)
      await saveSettings(testPrisma, off.id, { dailyDigest: false })
      const result = await runDigests(testPrisma, 'DIGEST_DAILY', { now: THURSDAY, deps: deps(THURSDAY) })
      expect(result.sent).toBeGreaterThanOrEqual(1)
      expect(email.to(await addressOf(yes.id))).toHaveLength(1)
      expect(email.to(await addressOf(off.id))).toHaveLength(0)
    })
  })

  describe('the weekly digest', () => {
    let recapCounter = 0
    async function recap(dateKey: string, createdAt: Date) {
      const row = await testPrisma.shipDayRecap.create({ data: { weekKey: `w-${tag}-${recapCounter++}`, dateKey, totalPosts: 42, topPosts: [{ postId: 'p', authorId: 'u', propsScore: 9, title: 'A tiny compiler' }], createdAt } })
      recaps.push(row.id)
    }

    it('recaps the reader’s Ship Day and their streak, on a Monday', async () => {
      const a = await reader()
      await recap('2026-10-23', new Date('2026-10-24T12:30:00Z'))
      await testPrisma.shipPost.create({ data: { authorId: a.id, kind: 'SHIP', title: 'My ship', body: 'Shipped it', shipDayKey: '2026-10-23', propsCount: 7, createdAt: new Date('2026-10-23T15:00:00Z') } })
      await testPrisma.user.update({ where: { id: a.id }, data: { currentStreak: 5, longestStreak: 5, lastStreakDay: '2026-10-25' } })
      await testPrisma.xPEvent.create({ data: { userId: a.id, type: 'PROJECT_CREATED', amount: 50, description: 'x', dedupeKey: `dg-${tag}-${a.id}`, createdAt: new Date('2026-10-25T10:00:00Z') } })
      expect(await weeklyOutcome(a.id)).toBe('SENT')
      const [mail] = email.to(await addressOf(a.id))
      expect(mail.subject).toBe('Your week on the platform')
      expect(mail.html).toContain('You shipped 1 post and got 7 Props on it')
      expect(mail.html).toContain('42 builders shipped on Ship Day')
      expect(mail.html).toContain('The week’s top post: “A tiny compiler”')
      expect(mail.html).toContain('Your streak is 5 days')
      expect(mail.html).toContain('You were active on 1 of the last 7 days')
      expect(readUnsubscribeToken(new URL(mail.headers!['List-Unsubscribe'].slice(1, -1)).searchParams.get('t')!)).toEqual({ userId: a.id, kind: 'DIGEST_WEEKLY' })
    })

    it('is only sent on a Monday, from 09:00, once a week', async () => {
      const a = await reader()
      await recap('2026-10-23', new Date('2026-10-24T12:30:00Z'))
      await testPrisma.user.update({ where: { id: a.id }, data: { currentStreak: 2, longestStreak: 2, lastStreakDay: '2026-10-25' } })
      expect(await weeklyOutcome(a.id, new Date('2026-10-23T10:00:00Z'))).toBe('NOT_DUE')
      expect(await weeklyOutcome(a.id, new Date('2026-10-26T08:00:00Z'))).toBe('NOT_DUE')
      expect(await weeklyOutcome(a.id, MONDAY)).toBe('SENT')
      expect(await weeklyOutcome(a.id, new Date('2026-10-26T15:00:00Z'))).toBe('NOT_DUE')
    })

    it('is not sent for a week with nothing of the reader’s in it, though Ship Day happened', async () => {
      const a = await reader()
      await recap('2026-10-23', new Date('2026-10-24T12:30:00Z'))
      expect(await weeklyOutcome(a.id)).toBe('NOTHING_TO_SEND')
      expect(email.outbox).toHaveLength(0)
    })
  })
})
