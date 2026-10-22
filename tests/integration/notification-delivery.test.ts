import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest'
import { cleanupTestUsers, testPrisma } from './db'
import { uniqueSuffix } from './helpers'
import { INTEGRATION_DATABASE_URL } from './config'
import { makePerson, removePeople, type FixtureOptions } from './matching-fixtures'
import { MemoryEmail } from '../../src/lib/infra/email.memory'
import { MemoryPush } from '../../src/lib/infra/push.memory'
import { releaseDeferred, sweepNotifications, type DispatchDeps } from '../../src/lib/notify/dispatch'
import { processEmailEvent } from '../../src/lib/notify/webhook'
import { readUnsubscribeToken } from '../../src/lib/notify/tokens'
import { saveSettings, setChannelChoice, suppressAddress } from '../../src/lib/notify/settings'
import type { NotificationType, Prisma } from '@prisma/client'
import { invalidateFlags } from '../../src/lib/flags'

// The delivery pipeline against a real database, with the in-memory email and push senders: what leaves the app for a notification, and what does not. Time is
// passed in, so quiet hours and limits are exercised without waiting.
describe('notification delivery', () => {
  const suffix = uniqueSuffix()
  const tag = `nd${suffix}`
  const NOON = new Date('2026-10-22T12:00:00Z')
  let email: MemoryEmail
  let push: MemoryPush
  const deps = (now: Date = NOON): DispatchDeps => ({ email, push, baseUrl: 'https://app.test', now })

  beforeAll(() => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  beforeEach(() => {
    email = new MemoryEmail()
    push = new MemoryPush()
  })
  afterAll(async () => {
    await removePeople(tag)
    await testPrisma.emailSuppression.deleteMany({ where: { email: { contains: tag } } })
    await testPrisma.featureFlag.updateMany({ where: { key: 'kill.notification-delivery' }, data: { enabled: false } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  const person = (options: Partial<FixtureOptions> = {}) => makePerson({ tag, profile: false, timezone: 'UTC', ...options })
  let endpointCounter = 0
  const subscribe = async (userId: string) => {
    const endpoint = `https://push.example.test/${tag}/${endpointCounter++}`
    await testPrisma.pushSubscription.create({ data: { userId, endpoint, p256dh: 'BKey123456', auth: 'authsecret1' } })
    return endpoint
  }
  const notify = (userId: string, type: NotificationType, over: { kind?: string; title?: string; message?: string; link?: string | null; metadata?: Prisma.InputJsonValue; at?: Date } = {}) =>
    testPrisma.notification.create({
      data: {
        userId,
        type,
        title: over.title ?? 'A title',
        message: over.message ?? 'A message',
        link: over.link === undefined ? '/somewhere' : over.link,
        metadata: over.metadata ?? (over.kind ? { kind: over.kind } : undefined),
        createdAt: over.at ?? new Date(NOON.getTime() - 60_000),
      },
    })
  const addressOf = async (userId: string) => (await testPrisma.user.findUniqueOrThrow({ where: { id: userId } })).email
  const deliveries = (userId: string) => testPrisma.notificationDelivery.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })

  describe('what is sent, and where', () => {
    it('pushes a comment to a subscribed browser, with the delivery id so a tap can be reported, and sends no email (off by default for that kind)', async () => {
      const a = await person()
      const endpoint = await subscribe(a.id)
      const n = await notify(a.id, 'COMMENT', { kind: 'COMMENT', title: 'New comment', message: 'Grace replied: nice build', link: '/posts/p1' })
      const result = await sweepNotifications(testPrisma, deps())
      expect(result.sent).toBe(1)
      expect(push.to(endpoint)).toHaveLength(1)
      const sent = push.to(endpoint)[0]
      expect(sent.payload).toMatchObject({ title: 'New comment', body: 'Grace replied: nice build', url: '/posts/p1' })
      const rows = await deliveries(a.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ channel: 'PUSH', status: 'SENT', kind: 'COMMENT', notificationId: n.id })
      expect(sent.payload.deliveryId).toBe(rows[0].id)
      expect(email.outbox).toHaveLength(0)
      expect((await testPrisma.notification.findUniqueOrThrow({ where: { id: n.id } })).sweptAt).not.toBeNull()
    })

    it('emails a squad invitation with the one-click unsubscribe headers and links, and a click-through link that opens it', async () => {
      const a = await person()
      await notify(a.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE', title: 'Squad invitation', message: 'Ada invited you to join NightShift', link: '/teams/t1' })
      await sweepNotifications(testPrisma, deps())
      const mail = email.to(await addressOf(a.id))
      expect(mail).toHaveLength(1)
      expect(mail[0].subject).toBe('Squad invitation')
      expect(mail[0].html).toContain('Ada invited you to join NightShift')
      expect(mail[0].html).toContain('Stop emails like this')
      const header = mail[0].headers!['List-Unsubscribe']
      expect(mail[0].headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
      const token = new URL(header.slice(1, -1)).searchParams.get('t')!
      expect(readUnsubscribeToken(token)).toEqual({ userId: a.id, kind: 'SQUAD_INVITE' })
      expect(mail[0].html).toContain('https://app.test/api/notifications/open/')
      expect(mail[0].tags).toMatchObject({ kind: 'SQUAD_INVITE' })
      expect((await deliveries(a.id))[0]).toMatchObject({ channel: 'EMAIL', status: 'SENT', providerId: expect.stringMatching(/^mem_/) })
    })

    it('resolves a notification that names no kind by its type', async () => {
      const a = await person()
      await notify(a.id, 'NEW_MESSAGE', { title: 'New message', message: 'Ada: hello there', link: '/messages/c1', metadata: { conversationId: 'c-none', messageId: 'm1' } })
      await sweepNotifications(testPrisma, deps())
      expect((await deliveries(a.id)).map((row) => `${row.channel}:${row.kind}`)).toEqual(['EMAIL:NEW_MESSAGE'])
      expect(email.outbox[0].html).toContain('Ada: hello there')
    })

    it('does nothing twice: a second sweep sends nothing and the log keeps one row per thing and channel', async () => {
      const a = await person()
      await subscribe(a.id)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT' })
      await sweepNotifications(testPrisma, deps())
      const again = await sweepNotifications(testPrisma, deps())
      expect(again.claimed).toBe(0)
      expect(push.sent).toHaveLength(1)
      expect(await deliveries(a.id)).toHaveLength(1)
    })

    it('does not mail or push the history that existed before delivery did', async () => {
      const a = await person()
      await subscribe(a.id)
      const old = await notify(a.id, 'COMMENT', { kind: 'COMMENT', at: new Date(NOON.getTime() - 3 * 24 * 3600_000) })
      // The migration stamps old rows; a sweep that finds one anyway drops it as stale rather than sending yesterday's news.
      await sweepNotifications(testPrisma, deps())
      expect(push.sent).toHaveLength(0)
      expect((await deliveries(a.id)).map((row) => `${row.status}:${row.reason}`)).toEqual(['SKIPPED:STALE'])
      expect(old.id).toBeTruthy()
    })

    it('sends nothing to a person who is gone, or whose address was never verified', async () => {
      const gone = await person({ deleted: true })
      const unverified = await person({ emailVerified: false })
      await notify(gone.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      await notify(unverified.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      await sweepNotifications(testPrisma, deps())
      expect(email.outbox).toHaveLength(0)
    })
  })

  describe('choices', () => {
    it('lets a person switch a kind on by email, and off by push, each on its own', async () => {
      const a = await person()
      await subscribe(a.id)
      await setChannelChoice(testPrisma, a.id, 'COMMENT', 'EMAIL', true)
      await setChannelChoice(testPrisma, a.id, 'COMMENT', 'PUSH', false)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT', title: 'New comment' })
      await sweepNotifications(testPrisma, deps())
      expect(push.sent).toHaveLength(0)
      expect(email.outbox).toHaveLength(1)
    })

    it('stops every optional email on the global switch, but still sends an account notice', async () => {
      const a = await person()
      await saveSettings(testPrisma, a.id, { emailEnabled: false })
      await notify(a.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      await notify(a.id, 'SYSTEM', { kind: 'MODERATION', title: 'Your account was suspended', message: 'For harassment of another member', link: '/settings/account' })
      await sweepNotifications(testPrisma, deps())
      expect(email.outbox).toHaveLength(1)
      // Only that there is an account notice, never what it says; no way to unsubscribe from it.
      const sent = email.outbox[0]
      expect(sent.subject).toBe('You have an account notice')
      expect(sent.html + sent.text).not.toMatch(/suspended|harassment/)
      expect(sent.headers).toEqual({})
      expect(sent.html).not.toContain('Stop emails like this')
    })

    it('never mails an address that bounced, an account notice included, and records why', async () => {
      const a = await person()
      await suppressAddress(testPrisma, await addressOf(a.id), 'BOUNCE')
      await notify(a.id, 'SYSTEM', { kind: 'MODERATION' })
      await sweepNotifications(testPrisma, deps())
      expect(email.outbox).toHaveLength(0)
      expect((await deliveries(a.id)).map((row) => `${row.status}:${row.reason}`)).toEqual(['SKIPPED:SUPPRESSED'])
    })
  })

  describe('quiet hours', () => {
    it('holds a push until the person’s night is over, in their own zone, then sends it', async () => {
      // 20:30 UTC is 02:00 the next morning in Kolkata.
      const night = new Date('2026-10-22T20:30:00Z')
      const a = await person({ timezone: 'Asia/Kolkata' })
      const endpoint = await subscribe(a.id)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT', title: 'New comment', at: new Date(night.getTime() - 60_000) })
      const swept = await sweepNotifications(testPrisma, deps(night))
      expect(swept.deferred).toBe(1)
      expect(push.sent).toHaveLength(0)
      const [held] = await deliveries(a.id)
      expect(held).toMatchObject({ status: 'DEFERRED', reason: 'QUIET_HOURS' })
      expect(held.sendAfter!.toISOString()).toBe('2026-10-23T02:30:00.000Z')

      // Not yet.
      expect((await releaseDeferred(testPrisma, deps(new Date('2026-10-23T01:00:00Z')))).claimed).toBe(0)
      const released = await releaseDeferred(testPrisma, deps(new Date('2026-10-23T02:31:00Z')))
      expect(released.sent).toBe(1)
      expect(push.to(endpoint)).toHaveLength(1)
      expect((await deliveries(a.id))[0].status).toBe('SENT')
    })

    it('sends a pile of held pushes as one line, so a night of comments is not twelve buzzes at breakfast', async () => {
      const night = new Date('2026-10-22T23:30:00Z')
      const a = await person()
      await subscribe(a.id)
      for (let i = 0; i < 4; i++) await notify(a.id, 'COMMENT', { kind: 'COMMENT', title: `Comment ${i}`, link: `/posts/p${i}`, at: new Date(night.getTime() - 60_000) })
      await sweepNotifications(testPrisma, deps(night))
      expect(push.sent).toHaveLength(0)
      const released = await releaseDeferred(testPrisma, deps(new Date('2026-10-23T08:01:00Z')))
      expect(released.sent).toBe(1)
      expect(released.summarised).toBe(3)
      expect(push.sent).toHaveLength(1)
      expect(push.sent[0].payload.title).toBe('You have 4 new notifications')
      expect(JSON.stringify(push.sent[0].payload)).not.toContain('Comment 0')
      expect((await deliveries(a.id)).map((row) => row.status).sort()).toEqual(['SENT', 'SKIPPED', 'SKIPPED', 'SKIPPED'])
    })

    it('drops what waited so long it is no longer news', async () => {
      const night = new Date('2026-10-22T23:30:00Z')
      const a = await person({ timezone: 'UTC' })
      await subscribe(a.id)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT', at: new Date(night.getTime() - 60_000) })
      await sweepNotifications(testPrisma, deps(night))
      // Released the next evening, a day later.
      await testPrisma.notificationDelivery.updateMany({ where: { userId: a.id }, data: { sendAfter: new Date('2026-10-23T08:00:00Z') } })
      await releaseDeferred(testPrisma, deps(new Date('2026-10-23T20:00:00Z')))
      expect(push.sent).toHaveLength(0)
      expect((await deliveries(a.id)).map((row) => `${row.status}:${row.reason}`)).toEqual(['SKIPPED:STALE'])
    })

    it('does not hold an account notice for the night', async () => {
      const night = new Date('2026-10-22T23:30:00Z')
      const a = await person()
      await notify(a.id, 'SYSTEM', { kind: 'MODERATION', at: new Date(night.getTime() - 60_000) })
      await sweepNotifications(testPrisma, deps(night))
      expect(email.outbox).toHaveLength(1)
    })
  })

  describe('limits', () => {
    it('sends the first pushes of a kind in an hour and skips the rest, and says so in the log', async () => {
      const a = await person()
      await subscribe(a.id)
      for (let i = 0; i < 4; i++) await notify(a.id, 'COMMENT', { kind: 'COMMENT', link: `/posts/p${i}` })
      const result = await sweepNotifications(testPrisma, deps())
      expect(result.sent).toBe(3)
      expect(push.sent).toHaveLength(3)
      expect((await deliveries(a.id)).filter((row) => row.status === 'SKIPPED').map((row) => row.reason)).toEqual(['RATE_LIMIT'])
    })

    it('does not send two pushes for the same place within the hour', async () => {
      const a = await person()
      await subscribe(a.id)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT', link: '/posts/same', title: 'First', at: new Date(NOON.getTime() - 120_000) })
      await sweepNotifications(testPrisma, deps())
      await notify(a.id, 'COMMENT', { kind: 'COMMENT', link: '/posts/same', title: 'Second' })
      await sweepNotifications(testPrisma, deps(new Date(NOON.getTime() + 1000)))
      expect(push.sent.map((p) => p.payload.title)).toEqual(['First'])
      expect((await deliveries(a.id)).map((row) => row.reason)).toContain('DUPLICATE')
    })
  })

  describe('the romance mode', () => {
    it('lets only a neutral line out, by push and by email, whichever way a romance notification is written', async () => {
      const a = await person()
      const b = await person()
      const endpoint = await subscribe(a.id)
      await setChannelChoice(testPrisma, a.id, 'ROMANCE_SPARK', 'EMAIL', true)
      await notify(a.id, 'SPARK', { kind: 'ROMANCE_SPARK', title: 'Private mode', message: 'Grace Hopper sparked you', link: '/romance', metadata: { kind: 'ROMANCE_SPARK', fromId: b.id } })
      // A match made there, and a message in its conversation: both written without a ROMANCE kind.
      const [x, y] = [a.id, b.id].sort()
      const conversation = await testPrisma.conversation.create({ data: { type: 'DIRECT', members: { create: [{ userId: a.id }, { userId: b.id }] } } })
      await testPrisma.match.create({ data: { userAId: x, userBId: y, userARole: 'DATING', userBRole: 'DATING', connectionType: 'DATING', conversationId: conversation.id } })
      await notify(a.id, 'NEW_MESSAGE', { title: 'New message', message: 'Grace: dinner on friday?', link: `/messages/${conversation.id}`, metadata: { conversationId: conversation.id, messageId: 'm1' } })
      await sweepNotifications(testPrisma, deps())

      const pushed = push.to(endpoint)
      expect(pushed.length).toBeGreaterThanOrEqual(1)
      expect(push.sent.map((p) => p.payload.tag)).toEqual(push.sent.map(() => 'message'))
      for (const p of push.sent) {
        expect(p.payload.title).toBe('You have a new message')
        expect(p.payload.url).toBe('/notifications')
        expect(JSON.stringify(p.payload)).not.toMatch(/Grace|Hopper|dinner|sparked|romance|private mode/i)
      }
      for (const mail of email.outbox) {
        expect(mail.subject).toBe('You have a new message')
        // Nothing the recipient's mail server, or the provider, can read says what it is about: not the headers, not the tags, not the link tokens.
        const header = mail.headers!['List-Unsubscribe']
        const scope = readUnsubscribeToken(new URL(header.slice(1, -1)).searchParams.get('t')!)
        expect(scope).toEqual({ userId: a.id, kind: 'NEUTRAL' })
        expect(JSON.stringify([mail.headers, mail.tags])).not.toMatch(/romance|dating|spark|private/i)
        expect(mail.html + mail.text).not.toMatch(/Activity in a private mode/)
        expect(mail.html + mail.text).not.toMatch(/Grace|Hopper|dinner|sparked|romance|private mode/i)
        expect(mail.html + mail.text).not.toContain(a.username)
      }
      const kinds = (await deliveries(a.id)).map((row) => row.kind)
      expect(kinds).toContain('ROMANCE_SPARK')
      expect(kinds).toContain('ROMANCE_MESSAGE')
    })

    it('does not email a romance notification unless the person opted in to that', async () => {
      const a = await person()
      await notify(a.id, 'SPARK', { kind: 'ROMANCE_SPARK', title: 'Private mode', message: 'Someone sparked you', metadata: { kind: 'ROMANCE_SPARK' } })
      await sweepNotifications(testPrisma, deps())
      expect(email.outbox).toHaveLength(0)
    })
  })

  describe('when a send fails', () => {
    it('tries a refused-for-now email again later, and gives up on a refused-for-good one', async () => {
      const slow = await person()
      const bad = await person()
      email.failFor(await addressOf(slow.id), true)
      email.failFor(await addressOf(bad.id), false)
      await notify(slow.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      await notify(bad.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      await sweepNotifications(testPrisma, deps())
      const [held] = await deliveries(slow.id)
      expect(held).toMatchObject({ status: 'DEFERRED', reason: 'RETRY', attempts: 1 })
      expect((await deliveries(bad.id))[0]).toMatchObject({ status: 'FAILED', reason: 'REFUSED' })

      email.clearFailures()
      const released = await releaseDeferred(testPrisma, deps(new Date(NOON.getTime() + 10 * 60_000)))
      expect(released.sent).toBe(1)
      expect((await deliveries(slow.id))[0]).toMatchObject({ status: 'SENT', attempts: 2 })
      expect(email.outbox).toHaveLength(1)
    })

    it('forgets a browser the push service says is gone', async () => {
      const a = await person()
      const endpoint = await subscribe(a.id)
      push.markGone(endpoint)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT' })
      await sweepNotifications(testPrisma, deps())
      expect(await testPrisma.pushSubscription.count({ where: { userId: a.id } })).toBe(0)
      expect((await deliveries(a.id))[0]).toMatchObject({ status: 'FAILED', reason: 'GONE' })
    })

    it('does not reach the browsers beyond the first five, and pushes to every other', async () => {
      const a = await person()
      for (let i = 0; i < 7; i++) await subscribe(a.id)
      await notify(a.id, 'COMMENT', { kind: 'COMMENT' })
      await sweepNotifications(testPrisma, deps())
      expect(push.sent).toHaveLength(5)
    })
  })

  describe('the kill switch', () => {
    it('stops all email and push while it is on, and sends none of the backlog after it is off', async () => {
      const a = await person()
      await subscribe(a.id)
      await testPrisma.featureFlag.update({ where: { key: 'kill.notification-delivery' }, data: { enabled: true } })
      await invalidateFlags()
      await notify(a.id, 'COMMENT', { kind: 'COMMENT' })
      const paused = await sweepNotifications(testPrisma, deps())
      expect(paused.claimed).toBe(1)
      expect(push.sent).toHaveLength(0)
      await testPrisma.featureFlag.update({ where: { key: 'kill.notification-delivery' }, data: { enabled: false } })
      await invalidateFlags()
      expect((await sweepNotifications(testPrisma, deps())).claimed).toBe(0)
      expect(push.sent).toHaveLength(0)
      // In-app, the notification is untouched.
      expect(await testPrisma.notification.count({ where: { userId: a.id } })).toBe(1)
    })
  })

  describe('bounces and complaints', () => {
    it('suppresses the address of a permanent bounce and of a complaint, and marks the delivery', async () => {
      const a = await person()
      await notify(a.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      await sweepNotifications(testPrisma, deps())
      const address = await addressOf(a.id)
      const [row] = await deliveries(a.id)
      const result = await processEmailEvent(testPrisma, { type: 'email.bounced', data: { email_id: row.providerId, to: [address], bounce: { type: 'Permanent' } } })
      expect(result).toEqual({ handled: 'BOUNCE', addresses: 1 })
      expect(await testPrisma.emailSuppression.findUnique({ where: { email: address.toLowerCase() } })).toMatchObject({ reason: 'BOUNCE' })
      expect((await deliveries(a.id))[0]).toMatchObject({ status: 'FAILED', reason: 'BOUNCED' })

      await processEmailEvent(testPrisma, { type: 'email.complained', data: { email_id: row.providerId, to: [address] } })
      expect(await testPrisma.emailSuppression.findUnique({ where: { email: address.toLowerCase() } })).toMatchObject({ reason: 'COMPLAINT' })

      // Then nothing more is sent to it.
      await notify(a.id, 'TEAM_INVITATION', { kind: 'SQUAD_INVITE' })
      email.outbox.length = 0
      await sweepNotifications(testPrisma, deps(new Date(NOON.getTime() + 1000)))
      expect(email.outbox).toHaveLength(0)
    })

    it('leaves a transient bounce and other events alone', async () => {
      const a = await person()
      const address = await addressOf(a.id)
      expect(await processEmailEvent(testPrisma, { type: 'email.bounced', data: { to: [address], bounce: { type: 'Transient' } } })).toMatchObject({ handled: 'IGNORED' })
      expect(await processEmailEvent(testPrisma, { type: 'email.delivered', data: { to: [address] } })).toMatchObject({ handled: 'IGNORED' })
      expect(await testPrisma.emailSuppression.count({ where: { email: address.toLowerCase() } })).toBe(0)
    })
  })
})
