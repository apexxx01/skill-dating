import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { registerAndLogin, req, uniqueSuffix, type TestUser } from './helpers'
import { makePerson, removePeople } from './matching-fixtures'
import { fillActivity, measureDay, runSnapshot, writeSnapshot } from '../../src/lib/kpi/snapshot'
import type { MetricRow } from '../../src/lib/kpi/types'

const at = (iso: string) => new Date(iso)
const D = '2026-06-15' // a Monday, long before anything else in the shared database: every window below is relative to it

// The nightly numbers against a database with known rows, one metric at a time. Every number is measured for the people made here only (the scope), on a day in the past, so the
// rest of the database cannot move them. The expected values are worked out in the comments from the rows.
describe('metrics', () => {
  const suffix = uniqueSuffix().toLowerCase()
  const tag = `mt${suffix}`
  const people: string[] = []
  const cleanup = { hackathons: [] as string[], teams: [] as string[], posts: [] as string[], conversations: [] as string[], codes: [] as string[], recaps: [] as string[] }
  let all: MetricRow[]

  const person = async (createdAt = '2026-01-01T00:00:00Z', over: { deleted?: boolean } = {}) => {
    const made = await makePerson({ tag, profile: false, deleted: over.deleted })
    await testPrisma.user.update({ where: { id: made.id }, data: { createdAt: at(createdAt) } })
    people.push(made.id)
    return made.id
  }
  const event = (userId: string, name: string, when: string) => testPrisma.productEvent.create({ data: { userId, name, createdAt: at(when) } })
  const find = (key: string, dimension = '') => all.find((entry) => entry.key === key && entry.dimension === dimension)
  const valueOf = (key: string, dimension = '') => find(key, dimension)?.value
  const near = (actual: number | undefined, expected: number) => expect(actual).toBeCloseTo(expected, 4)

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    await build()
  }, 120_000)
  afterAll(async () => {
    await testPrisma.shipPost.deleteMany({ where: { id: { in: cleanup.posts } } })
    await testPrisma.hackathon.deleteMany({ where: { id: { in: cleanup.hackathons } } })
    await testPrisma.team.deleteMany({ where: { id: { in: cleanup.teams } } })
    await testPrisma.conversation.deleteMany({ where: { id: { in: cleanup.conversations } } })
    await testPrisma.inviteCode.deleteMany({ where: { id: { in: cleanup.codes } } })
    await testPrisma.shipDayRecap.deleteMany({ where: { id: { in: cleanup.recaps } } })
    await testPrisma.metricsSnapshot.deleteMany({ where: { day: at(`${D}T00:00:00Z`) } })
    await removePeople(tag)
  }, 120_000)

  async function build() {
    // --- Activity: who was active when, and who showed work -----------------------------------------------------------------
    const a1 = await person() // active on D, a post at D-1, onboarding completed on D
    const a2 = await person() // active D-3, shipped D-3
    const a3 = await person() // active D-10: monthly, not weekly
    const a4 = await person() // active D-25: monthly only; a post that was deleted
    const a5 = await person() // active D-40: not even monthly
    const a6 = await person() // a hidden post at D-5, no activity
    const gone = await person('2026-01-01T00:00:00Z', { deleted: true })
    await event(a1, 'post_created', `${D}T12:00:00Z`)
    await event(a1, 'onboarding_completed', `${D}T12:05:00Z`)
    await event(a2, 'drop_viewed', '2026-06-12T09:00:00Z')
    await event(a2, 'project_shipped', '2026-06-12T09:30:00Z')
    await event(a3, 'spark_sent', '2026-06-05T09:00:00Z')
    await event(a4, 'comment_created', '2026-05-21T09:00:00Z')
    await event(a5, 'comment_created', '2026-05-06T09:00:00Z')
    await event(gone, 'post_created', `${D}T08:00:00Z`)
    const post = async (authorId: string, createdAt: string, over: Record<string, unknown> = {}) => {
      const row = await testPrisma.shipPost.create({ data: { authorId, kind: 'SHIP', title: 'T', body: 'B', createdAt: at(createdAt), ...over } })
      cleanup.posts.push(row.id)
      return row
    }
    await post(a1, '2026-06-14T10:00:00Z')
    await post(a4, '2026-06-13T10:00:00Z', { deletedAt: at('2026-06-13T11:00:00Z') })
    await post(a6, '2026-06-10T10:00:00Z', { moderatedAt: at('2026-06-10T11:00:00Z') })
    await testPrisma.projectUpdate.create({ data: { projectId: (await testPrisma.project.create({ data: { name: `P ${tag}`, slug: `p-${tag}`, ownerId: a3 } })).id, authorId: a3, title: 'u', content: 'c', createdAt: at('2026-06-05T10:00:00Z') } })

    // Signups on D: two people made on D (and one the day after, which is not D's).
    await person(`${D}T09:00:00Z`)
    await person(`${D}T21:00:00Z`)
    await person('2026-06-16T09:00:00Z')

    // --- Retention: a cohort of three who signed up on 2026-05-05 (ISO week 2026-W19) -------------------------------------------
    const r1 = await person('2026-05-05T10:00:00Z')
    const r2 = await person('2026-05-05T11:00:00Z')
    await person('2026-05-05T12:00:00Z') // r3: never came back
    await event(r1, 'drop_viewed', '2026-05-06T10:00:00Z') // day 1
    await event(r1, 'drop_viewed', '2026-05-12T10:00:00Z') // day 7
    await event(r1, 'drop_viewed', '2026-06-04T10:00:00Z') // day 30
    await event(r2, 'drop_viewed', '2026-05-12T10:00:00Z') // day 7 only

    // --- Activation: finished onboarding, then did (or did not) do something real -----------------------------------------------
    const x1 = await person() // W19: finished 05-05, posted on 05-07: activated
    const x2 = await person() // W19: finished 05-05, only looked at drops: not
    const x3 = await person() // finished 06-14: its 7 days are not over, not counted
    const x4 = await person() // W21: finished 05-20, a spark on 05-21: activated
    const x5 = await person() // W21: finished 05-21, nothing: not
    await event(x1, 'onboarding_completed', '2026-05-05T10:00:00Z')
    await event(x1, 'post_created', '2026-05-07T10:00:00Z')
    await event(x2, 'onboarding_completed', '2026-05-05T10:00:00Z')
    await event(x2, 'drop_viewed', '2026-05-06T10:00:00Z')
    await event(x3, 'onboarding_completed', '2026-06-14T10:00:00Z')
    await event(x4, 'onboarding_completed', '2026-05-20T10:00:00Z')
    await event(x4, 'spark_sent', '2026-05-21T10:00:00Z')
    await event(x5, 'onboarding_completed', '2026-05-21T10:00:00Z')
    // Signup to onboarding: two people who signed up on 05-25 and 05-26; one finished onboarding the next day.
    const y1 = await person('2026-05-25T10:00:00Z')
    await person('2026-05-26T10:00:00Z')
    await event(y1, 'onboarding_completed', '2026-05-26T10:00:00Z')

    // --- Matching ----------------------------------------------------------------------------------------------------------------
    const s1 = await person()
    const s2 = await person()
    const spark = (fromId: string, toId: string, connectionType: 'COFOUNDER' | 'MENTOR' | 'DATING', status: 'PENDING' | 'MATCHED', when: string) =>
      testPrisma.spark.create({ data: { fromId, toId, connectionType, status, opener: `opener ${Math.random()}`.padEnd(30, 'x'), openerHash: `h${Math.random()}`, createdAt: at(when) } })
    const others = [await person(), await person(), await person(), await person()]
    await spark(s1, others[0], 'COFOUNDER', 'MATCHED', '2026-06-01T10:00:00Z')
    await spark(s1, others[1], 'COFOUNDER', 'PENDING', '2026-06-02T10:00:00Z')
    await spark(s1, others[2], 'MENTOR', 'PENDING', '2026-06-03T10:00:00Z')
    await spark(s2, others[0], 'COFOUNDER', 'PENDING', '2026-06-04T10:00:00Z')
    await spark(s2, others[1], 'DATING', 'MATCHED', '2026-06-04T10:00:00Z') // the romance mode: not counted
    await spark(s2, others[3], 'COFOUNDER', 'MATCHED', '2026-06-12T10:00:00Z') // too recent to have had its week
    // 4 counted sparks, 1 matched: 0.25.
    const match = async (a: string, b: string, connectionType: 'COFOUNDER' | 'DATING', when: string, messages: { type: string; at: string }[]) => {
      const [userAId, userBId] = [a, b].sort()
      const conversation = await testPrisma.conversation.create({ data: { type: 'DIRECT', members: { create: [{ userId: a }, { userId: b }] } } })
      cleanup.conversations.push(conversation.id)
      await testPrisma.match.create({ data: { userAId, userBId, userARole: connectionType, userBRole: connectionType, connectionType, conversationId: conversation.id, createdAt: at(when) } })
      for (const message of messages) await testPrisma.message.create({ data: { conversationId: conversation.id, senderId: a, content: 'hi', type: message.type as 'TEXT', createdAt: at(message.at) } })
    }
    await match(s1, others[0], 'COFOUNDER', '2026-06-01T12:00:00Z', [{ type: 'SYSTEM', at: '2026-06-01T12:00:01Z' }, { type: 'TEXT', at: '2026-06-02T12:00:00Z' }]) // talked
    await match(s1, others[1], 'COFOUNDER', '2026-06-02T12:00:00Z', [{ type: 'SYSTEM', at: '2026-06-02T12:00:01Z' }, { type: 'TEXT', at: '2026-06-20T12:00:00Z' }]) // a message, but weeks later
    await match(s2, others[2], 'DATING', '2026-06-03T12:00:00Z', [{ type: 'TEXT', at: '2026-06-03T13:00:00Z' }]) // romance: not counted
    // 2 counted matches, 1 with a first message in 7 days: 0.5.
    const drop = (userId: string, candidateId: string, over: { viewedAt?: string; status?: 'NEW' | 'SPARKED' | 'PASSED' | 'EXPIRED'; created: string; localDate: string }) =>
      testPrisma.drop.create({ data: { userId, candidateId, connectionType: 'COFOUNDER', score: 60, localDate: over.localDate, status: over.status ?? 'NEW', viewedAt: over.viewedAt ? at(over.viewedAt) : null, expiresAt: at(`${over.localDate}T23:59:00Z`), createdAt: at(over.created) } })
    await drop(s1, others[0], { created: '2026-06-08T09:00:00Z', localDate: '2026-06-08', viewedAt: '2026-06-08T10:00:00Z', status: 'SPARKED' })
    await drop(s1, others[1], { created: '2026-06-09T09:00:00Z', localDate: '2026-06-09', viewedAt: '2026-06-09T10:00:00Z', status: 'PASSED' })
    await drop(s1, others[2], { created: '2026-06-10T09:00:00Z', localDate: '2026-06-10', viewedAt: '2026-06-10T10:00:00Z', status: 'EXPIRED' })
    await drop(s1, others[3], { created: '2026-06-11T09:00:00Z', localDate: '2026-06-11', status: 'EXPIRED' })
    await drop(s2, others[0], { created: '2026-06-15T09:00:00Z', localDate: '2026-06-15' }) // the day itself: not yet had its day
    await drop(s2, others[1], { created: '2026-05-30T09:00:00Z', localDate: '2026-05-30', viewedAt: '2026-05-30T10:00:00Z' }) // too old for the window
    // 4 drops in the window: 3 viewed (0.75), 2 acted on (0.5).

    // --- The feed ----------------------------------------------------------------------------------------------------------------
    const p1 = await person()
    const p2 = await person()
    await post(p1, '2026-06-07T10:00:00Z', { propsCount: 4 })
    await post(p1, '2026-06-09T10:00:00Z', { propsCount: 2 })
    await post(p2, '2026-06-12T10:00:00Z', { propsCount: 0 })
    await post(p2, '2026-06-10T10:00:00Z', { propsCount: 9, deletedAt: at('2026-06-11T00:00:00Z') }) // deleted: not counted
    await post(p2, '2026-06-14T10:00:00Z', { propsCount: 9 }) // too recent to have been noticed in
    // 3 posts in the window, 6 Props: 2.0.
    const recap = await testPrisma.shipDayRecap.create({ data: { weekKey: `wk-${tag}`, dateKey: '2026-06-12', totalPosts: 9, createdAt: at('2026-06-13T12:30:00Z') } })
    cleanup.recaps.push(recap.id)
    await post(p1, '2026-06-12T08:00:00Z', { shipDayKey: '2026-06-12' })
    await post(p2, '2026-06-12T09:00:00Z', { shipDayKey: '2026-06-12' })
    for (const id of [p1, p2]) await event(id, 'drop_viewed', '2026-06-11T10:00:00Z')

    // --- Hackathons: squads ------------------------------------------------------------------------------------------------------
    const h = await person()
    const hackathon = await testPrisma.hackathon.create({ data: { name: `H ${tag}`, slug: `h-${tag}`, description: 'x', startDate: at('2026-05-20T00:00:00Z'), endDate: at('2026-06-01T00:00:00Z'), status: 'ENDED' } })
    cleanup.hackathons.push(hackathon.id)
    const team = async (name: string) => {
      const row = await testPrisma.team.create({ data: { name: `${name} ${tag}`, slug: `${name}-${tag}`, ownerId: h, hackathonId: hackathon.id } })
      cleanup.teams.push(row.id)
      await testPrisma.hackathonTeam.create({ data: { hackathonId: hackathon.id, teamId: row.id, name: `${name} ${tag}` } })
      return row.id
    }
    const [t1, t2] = [await team('t1'), await team('t2')]
    const hp = async (status: 'REGISTERED' | 'TEAM_FORMED' | 'SUBMITTED' | 'WITHDRAWN', teamId: string | null, joinedAfterHours: number | null) => {
      const userId = await person()
      await testPrisma.hackathonParticipant.create({
        data: { userId, hackathonId: hackathon.id, status, teamId, registeredAt: at('2026-05-20T10:00:00Z'), teamJoinedAt: joinedAfterHours === null ? null : new Date(at('2026-05-20T10:00:00Z').getTime() + joinedAfterHours * 3_600_000) },
      })
    }
    await hp('SUBMITTED', t1, 5)
    await hp('SUBMITTED', t1, 23)
    await hp('REGISTERED', null, null)
    await hp('WITHDRAWN', null, null) // withdrew: not among those registered
    await hp('TEAM_FORMED', t2, 3)
    // 4 registered, 3 in a squad (0.75). Hours to a squad: 3, 5, 23 -> median 5, 90th percentile 19.4. 2 squads, 1 submitted: 0.5.

    // --- Crews: made 30 to 59 days before the end of D (2026-04-17 to 2026-05-16) ---------------------------------------------------
    const crew = async (createdAt: string, over: Record<string, unknown> = {}) => {
      const row = await testPrisma.team.create({ data: { name: `Crew ${Math.random()}`, slug: `crew-${tag}-${Math.random().toString(36).slice(2)}`, ownerId: h, createdAt: at(createdAt), ...over } })
      cleanup.teams.push(row.id)
      return row.id
    }
    const c1 = await crew('2026-05-01T10:00:00Z')
    await post(h, '2026-05-10T10:00:00Z', { teamId: c1 }) // shipped within 30 days
    const c2Project = await testPrisma.project.create({ data: { name: `CP ${tag}`, slug: `cp-${tag}`, ownerId: h, shippedAt: at('2026-06-20T00:00:00Z') } })
    await crew('2026-05-01T11:00:00Z', { projectId: c2Project.id }) // its project shipped, but after 30 days
    const c3 = await crew('2026-05-02T10:00:00Z')
    await post(h, '2026-06-05T10:00:00Z', { teamId: c3 }) // a post, but after 30 days
    // 3 crews, 1 shipped: 0.3333.

    // --- Notifications -----------------------------------------------------------------------------------------------------------
    const n1 = await person()
    const delivery = (kind: string, channel: 'EMAIL' | 'PUSH', status: 'SENT' | 'FAILED', over: { opened?: string; sent?: string; reason?: string; provider?: boolean; userId?: string }) =>
      testPrisma.notificationDelivery.create({
        data: {
          userId: over.userId ?? n1,
          kind,
          channel,
          status,
          reason: over.reason ?? null,
          dedupeKey: `m-${tag}-${Math.random()}`,
          providerId: channel === 'EMAIL' && over.provider !== false ? `p-${Math.random()}` : null,
          sentAt: at(over.sent ?? '2026-06-01T10:00:00Z'),
          openedAt: over.opened ? at(over.opened) : null,
        },
      })
    await delivery('SQUAD_INVITE', 'EMAIL', 'SENT', { opened: '2026-06-01T10:30:00Z' }) // opened, and then acted
    await event(n1, 'post_created', '2026-06-01T10:40:00Z')
    await delivery('SQUAD_INVITE', 'EMAIL', 'SENT', { opened: '2026-06-01T12:00:00Z' }) // opened, no action
    await delivery('SQUAD_INVITE', 'EMAIL', 'SENT', {})
    await delivery('SQUAD_INVITE', 'EMAIL', 'FAILED', { reason: 'BOUNCED' })
    await delivery('DIGEST_DAILY', 'EMAIL', 'SENT', { opened: '2026-06-02T10:30:00Z', sent: '2026-06-02T10:00:00Z' })
    await delivery('DIGEST_DAILY', 'EMAIL', 'SENT', { sent: '2026-06-03T10:00:00Z' })
    await delivery('COMMENT', 'PUSH', 'SENT', { opened: '2026-06-04T10:05:00Z', sent: '2026-06-04T10:00:00Z' })
    await delivery('COMMENT', 'PUSH', 'SENT', { sent: '2026-06-05T10:00:00Z' })
    await delivery('COMMENT', 'PUSH', 'SENT', { sent: '2026-06-06T10:00:00Z', opened: '2026-06-10T10:00:00Z' }) // opened days later: not within 48 hours
    await delivery('SQUAD_INVITE', 'EMAIL', 'SENT', { sent: '2026-06-14T10:00:00Z', opened: '2026-06-14T11:00:00Z' }) // too recent: outside the window

    // --- Safety ------------------------------------------------------------------------------------------------------------------
    const reported = await person()
    const report = (createdAt: string, over: { resolvedAt?: string; status?: 'PENDING' | 'REVIEWING' | 'RESOLVED' | 'DISMISSED'; source?: 'USER' | 'AUTOMATED' } = {}) =>
      testPrisma.report.create({ data: { reportedId: reported, reason: 'SPAM', source: over.source ?? 'USER', status: over.status ?? 'PENDING', createdAt: at(createdAt), resolvedAt: over.resolvedAt ? at(over.resolvedAt) : null } })
    await report('2026-06-13T10:00:00Z') // in the week, open
    await report('2026-06-14T10:00:00Z', { status: 'RESOLVED', resolvedAt: '2026-06-15T10:00:00Z' }) // in the week, resolved after 24 hours
    await report('2026-06-10T00:00:00Z', { status: 'REVIEWING' }) // in the week, open, the oldest: 144 hours before the end of D
    await report('2026-06-11T10:00:00Z', { source: 'AUTOMATED' }) // filed by the platform: not per-thousand, but open
    await report('2026-05-20T00:00:00Z', { status: 'RESOLVED', resolvedAt: '2026-05-20T10:00:00Z' }) // resolved after 10 hours, within 28 days
    // Filed by people in the week: 3 (the automated one excluded). Weekly actives among these people: counted below.
    // Resolved in 28 days: 24 h and 10 h -> median 17, 90th percentile 22.6. Open at the end of D: 4 (three user + one automated), the oldest 144 hours.

    // --- Growth: places -------------------------------------------------------------------------------------------------------------
    const place = async (createdAt: string, profile: Record<string, unknown>) => {
      const id = await person(createdAt)
      await testPrisma.profile.create({ data: { userId: id, ...profile } })
    }
    await place('2026-03-01T00:00:00Z', { countryCode: 'IN', cityKey: 'pune', campusKey: 'iisc' })
    await place('2026-06-12T00:00:00Z', { countryCode: 'IN', cityKey: 'pune', campusKey: 'iisc' })
    await place('2026-06-14T00:00:00Z', { countryCode: 'IN', cityKey: 'pune', campusKey: 'iisc' })
    await place('2026-06-14T00:00:00Z', { countryCode: 'US', cityKey: 'austin' })
    await place('2026-03-01T00:00:00Z', { countryCode: 'US', cityKey: 'austin' })
    // IN: 3 (2 new this week), Pune: 3, campus iisc: 3. US has 2 people: below the minimum of 3, so not reported.

    // --- Invites -------------------------------------------------------------------------------------------------------------------
    const owner = await person()
    const code = await testPrisma.inviteCode.create({ data: { code: `M${Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, 'Z')}`, kind: 'PERSONAL', ownerId: owner } })
    const campaign = await testPrisma.inviteCode.create({ data: { code: `C${Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, 'Z')}`, kind: 'CAMPAIGN', label: 'Metric test' } })
    cleanup.codes.push(code.id, campaign.id)
    const redeem = async (codeId: string, redeemedAt: string, qualifiedAfterDays: number | null, status: 'PENDING' | 'QUALIFIED' | 'REJECTED' = 'PENDING') => {
      const inviteeId = await person(redeemedAt)
      await testPrisma.inviteRedemption.create({
        data: { codeId, inviteeId, inviterId: codeId === code.id ? owner : null, status, redeemedAt: at(redeemedAt), qualifiedAt: qualifiedAfterDays === null ? null : new Date(at(redeemedAt).getTime() + qualifiedAfterDays * 86_400_000) },
      })
    }
    // Redeemed 14 to 41 days before the end of D (2026-05-05 to 2026-06-01); the people are made on the day they redeem, and none falls in the retention cohort above: personal 2 of 3 started within 14 days, campaign 1 of 1.
    await redeem(code.id, '2026-05-11T10:00:00Z', 2, 'QUALIFIED')
    await redeem(code.id, '2026-05-12T10:00:00Z', 20, 'QUALIFIED') // got started, but after 14 days
    await redeem(code.id, '2026-05-13T10:00:00Z', 1, 'QUALIFIED')
    await redeem(campaign.id, '2026-05-14T10:00:00Z', 3, 'QUALIFIED')
    // Redeemed in the 28 days up to D: these two (and the three people of the next window are older).
    await redeem(code.id, '2026-06-10T10:00:00Z', null)
    await redeem(campaign.id, '2026-06-12T10:00:00Z', null)

    // The base, then everything, for these people only.
    await fillActivity(testPrisma, '2026-04-01', D)
    all = (await measureDay(testPrisma, D, { userIds: people })).rows
  }

  describe('activity', () => {
    it('counts the people active on the day, in the week and in the month', () => {
      // On D: a1.
      expect(valueOf('dau')).toBe(1)
      // The week 2026-06-09 to 2026-06-15: a1, a2 (D-3), p1 and p2 (D-4) and x3 (finished onboarding on 06-14). Sending a spark or being sent one does not make a person active by itself.
      expect(valueOf('wau')).toBe(5)
      // The month 2026-05-17 to 2026-06-15 adds a3 (06-05), a4 (05-21), r1 (06-04), x4 and x5 (05-20, 05-21), y1 (05-26) and n1 (06-01). a5 (05-06), r2 and x1 and x2 (early May) are outside it.
      expect(valueOf('mau')).toBe(12)
    })

    it('makes stickiness from them', () => {
      near(valueOf('stickiness_dau_mau'), 1 / 12)
      near(valueOf('stickiness_wau_mau'), 5 / 12)
    })

    it('leaves out a person whose account is deleted, and one who was only ever active outside the month', async () => {
      const active = await testPrisma.activityDay.findMany({ where: { userId: { in: people } }, select: { userId: true, day: true } })
      const deleted = await testPrisma.user.findMany({ where: { id: { in: people }, deletedAt: { not: null } }, select: { id: true } })
      for (const entry of deleted) expect(active.some((a) => a.userId === entry.id)).toBe(false)
    })

    it('counts the people who showed their work in the week: a post, an update or a shipped project, not a deleted or hidden post', () => {
      // a1 (a post on D-1), a2 (a project shipped on D-3), p1 and p2 (posts in the week). h's posts (05-10, 06-05) are outside the week and a3's project update is on D-10;
      // a4's post was deleted and a6's was hidden by a moderator: not counted.
      expect(valueOf('weekly_active_shippers')).toBe(4)
      near(valueOf('shippers_share_of_wau'), 4 / 5)
      expect(find('weekly_active_shippers')?.detail).toMatchObject({ posts: 3, projectUpdates: 0, shipped: 1 })
    })

    it('counts signups on the day, onboardings finished on it, and the people who existed at its end', () => {
      expect(valueOf('signups')).toBe(2)
      expect(valueOf('onboarding_completed')).toBe(1)
      const created = people.length
      // Everyone made here except the one made after D, the deleted one: total_users counts those created before the end of D that still exist.
      expect(valueOf('total_users')).toBe(created - 1 - 1)
    })
  })

  describe('retention', () => {
    it('measures day 1, 7 and 30 for a signup week from the people whose day has come', () => {
      near(valueOf('retention_d1', '2026-W19'), 1 / 3)
      near(valueOf('retention_d7', '2026-W19'), 2 / 3)
      near(valueOf('retention_d30', '2026-W19'), 1 / 3)
      expect(find('retention_d7', '2026-W19')?.detail).toEqual({ cohort: 3, eligible: 3, retained: 2 })
    })

    it('gives a week no number for a day that has not come yet', () => {
      // The people made on D-1.. are younger than a day: their week has no day 30 and no day 7.
      expect(find('retention_d30', '2026-W25')).toBeUndefined()
      expect(find('retention_d7', '2026-W25')).toBeUndefined()
    })

    it('counts a person active on the exact day, not on a later one', async () => {
      // r2 came back on day 7, not day 1: day 1 stays 1 of 3 although r2 was active within the week.
      near(valueOf('retention_d1', '2026-W19'), 1 / 3)
    })
  })

  describe('activation', () => {
    it('measures people who finished onboarding and did something real in the 7 days after, week by week and over the last four weeks', () => {
      near(valueOf('activation_7d', '2026-W19'), 0.5) // x1 posted, x2 only looked
      near(valueOf('activation_7d', '2026-W21'), 0.5) // x4 sparked, x5 did nothing
      near(valueOf('activation_7d', '2026-W22'), 0) // y1 finished on 05-26 and did nothing
      // The last four weeks of people whose 7 days are over (finished on or after 05-12): x4, x5 and y1, one of whom did something.
      near(valueOf('activation_7d', ''), 1 / 3)
      expect(find('activation_7d', '2026-W19')?.detail).toEqual({ eligible: 2, activated: 1 })
    })

    it('leaves out a person whose 7 days are not over', () => {
      expect(find('activation_7d', '2026-W25')).toBeUndefined()
    })

    it('measures onboarding within 7 days of signing up', () => {
      // People who signed up 05-12 to 06-08: y1 and y2, and three invitees (05-12, 05-13, 05-14); only y1 finished onboarding within 7 days.
      near(valueOf('onboarding_7d'), 0.2)
    })
  })

  describe('matching', () => {
    it('measures sparks that became matches, leaving out the romance mode and sparks too recent to have been answered', () => {
      near(valueOf('spark_to_match_rate'), 0.25)
      expect(find('spark_to_match_rate')?.detail).toEqual({ sparks: 4, matched: 1 })
    })

    it('measures matches in which someone wrote a message within a week, not counting the icebreaker', () => {
      near(valueOf('match_to_first_message_rate'), 0.5)
      expect(find('match_to_first_message_rate')?.detail).toEqual({ matches: 2, talked: 1 })
    })

    it('measures drops that were looked at, and that were answered', () => {
      near(valueOf('drops_viewed_rate'), 0.75)
      near(valueOf('drops_acted_rate'), 0.5)
      expect(find('drops_viewed_rate')?.detail).toEqual({ drops: 4, viewed: 3 })
    })
  })

  describe('feed', () => {
    it('measures Props per post for posts old enough to have been noticed, not counting a deleted post', () => {
      // Posts made 06-06 to 06-12: p1's three (4, 2 and 0 Props) and p2's two (0 and 0); p2's deleted post and its post of 06-14 are out. 6 Props over 5 posts.
      near(valueOf('props_per_post'), 6 / 5)
    })

    it('measures how many of the people active in the week posted on Ship Day', () => {
      // p1 and p2 posted on Friday 06-12; active in the week up to it: a2, p1 and p2.
      const entry = find('ship_day_participation', `wk-${tag}`)
      expect(entry?.detail).toEqual({ posted: 2, active: 3 })
      near(entry?.value, 2 / 3)
    })
  })

  describe('squads and crews', () => {
    it('measures the people of recent hackathons who ended in a squad, how long it took, and the squads that submitted', () => {
      near(valueOf('hackathon_squad_rate'), 0.75)
      near(valueOf('time_to_squad_median_hours'), 5)
      near(Number(find('time_to_squad_median_hours')?.detail?.p90Hours), 19.4)
      near(valueOf('squads_submitted_rate'), 0.5)
      expect(find('hackathon_squad_rate')?.detail).toMatchObject({ registered: 4, inSquad: 3 })
    })

    it('measures the crews that shipped within 30 days of being made', () => {
      near(valueOf('crews_shipped_30d_rate'), 1 / 3)
    })
  })

  describe('notifications', () => {
    it('measures opens and acts per channel, with the digests apart, over deliveries old enough to have been opened', () => {
      near(valueOf('delivery_open_rate', 'EMAIL'), 2 / 3)
      near(valueOf('delivery_act_rate', 'EMAIL'), 1 / 3)
      near(valueOf('delivery_open_rate', 'PUSH'), 1 / 3)
      near(valueOf('delivery_open_rate', 'DIGEST_DAILY'), 1 / 2)
      expect(find('delivery_open_rate', 'EMAIL')?.detail).toEqual({ sent: 3, opened: 2 })
      expect(find('delivery_open_rate', 'DIGEST_WEEKLY')).toBeUndefined()
    })

    it('measures the share of email that bounced or was reported', () => {
      near(valueOf('email_bounce_rate'), 1 / 6)
      near(valueOf('email_complaint_rate'), 0)
    })
  })

  describe('safety', () => {
    it('measures reports filed by people per thousand weekly actives, not counting the platform’s own', () => {
      const entry = find('reports_per_1k_wau')
      expect(entry?.detail).toMatchObject({ reports: 3, wau: 5 })
      near(entry?.value, 600)
    })

    it('measures the time to resolve a report, and the reports still open with the age of the oldest', () => {
      near(valueOf('moderation_time_to_action_median_hours'), 17)
      near(Number(find('moderation_time_to_action_median_hours')?.detail?.p90Hours), 22.6)
      expect(valueOf('moderation_open_reports')).toBe(3)
      expect(find('moderation_open_reports')?.detail).toMatchObject({ oldestHours: 144 })
    })
  })

  describe('growth', () => {
    it('counts people by country, city and verified campus, and signups of the week, hiding places with fewer than three people', () => {
      expect(valueOf('users_by_place', 'country:IN')).toBe(3)
      expect(valueOf('users_by_place', 'city:IN:pune')).toBe(3)
      expect(valueOf('users_by_place', 'campus:iisc')).toBe(3)
      expect(valueOf('signups_7d_by_place', 'country:IN')).toBe(2)
      expect(find('users_by_place', 'country:US')).toBeUndefined()
      expect(find('users_by_place', 'city:US:austin')).toBeUndefined()
    })
  })

  describe('invites', () => {
    it('measures the invites redeemed per active person, and how many invitees got started within 14 days', () => {
      expect(find('invites_per_active_user_28d')?.detail).toMatchObject({ redeemed: 2 })
      near(valueOf('invite_conversion_14d'), 3 / 4)
      near(valueOf('invite_conversion_14d', 'PERSONAL'), 2 / 3)
      near(valueOf('invite_conversion_14d', 'CAMPAIGN'), 1)
    })
  })

  describe('the job and the admin routes', () => {
    let admin: TestUser
    let member: TestUser

    beforeAll(async () => {
      admin = await registerAndLogin(`mtadmin${suffix}@test.dev`, `mtadmin${suffix}`)
      await promoteToAdmin(admin.userId)
      member = await registerAndLogin(`mtmember${suffix}@test.dev`, `mtmember${suffix}`)
      await writeSnapshot(testPrisma, D, all)
    }, 60_000)
    afterAll(() => cleanupTestUsers(suffix), 60_000)

    it('writes a day’s rows whole, and rewriting the day replaces them', async () => {
      const count = await testPrisma.metricsSnapshot.count({ where: { day: at(`${D}T00:00:00Z`) } })
      expect(count).toBe(all.length)
      await writeSnapshot(testPrisma, D, all)
      expect(await testPrisma.metricsSnapshot.count({ where: { day: at(`${D}T00:00:00Z`) } })).toBe(all.length)
      // Aggregates only: no row names a person.
      const rows = await testPrisma.metricsSnapshot.findMany({ where: { day: at(`${D}T00:00:00Z`) } })
      expect(JSON.stringify(rows)).not.toMatch(new RegExp(people[0]))
    })

    it('serves the numbers for a range with what every key means, to an admin only', async () => {
      const res = await req(admin.jar, 'GET', `/api/admin/metrics?from=${D}&to=${D}&keys=weekly_active_shippers,retention_d7`)
      expect(res.status, JSON.stringify(res.data)).toBe(200)
      expect(res.data).toMatchObject({ from: D, to: D, truncated: false })
      expect(res.data.definitions.map((d: { key: string }) => d.key).sort()).toEqual(['retention_d7', 'weekly_active_shippers'])
      expect(res.data.definitions[0].definition.length).toBeGreaterThan(30)
      const shippers = res.data.rows.find((r: { key: string }) => r.key === 'weekly_active_shippers')
      expect(shippers).toMatchObject({ day: D, dimension: '', value: 4 })
      expect(res.data.rows.some((r: { key: string; dimension: string }) => r.key === 'retention_d7' && r.dimension === '2026-W19')).toBe(true)
      expect(res.data.rows.every((r: { key: string }) => ['weekly_active_shippers', 'retention_d7'].includes(r.key))).toBe(true)
      expect(res.data.computedThrough).toBeTruthy()
      expect((await req(member.jar, 'GET', '/api/admin/metrics')).status).toBe(403)
      expect((await req(null, 'GET', '/api/admin/metrics')).status).toBe(401)
    })

    it('refuses a bad range or key', async () => {
      for (const query of ['from=2026-02-30', 'from=2026-06-15&to=2026-06-01', 'from=2024-01-01&to=2026-06-01', 'keys=dau,not_a_metric', 'from=junk']) {
        const res = await req(admin.jar, 'GET', `/api/admin/metrics?${query}`)
        expect(res.status, query).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    })

    it('exports the same numbers as a CSV file', async () => {
      const res = await fetch(`${(await import('./config')).INTEGRATION_BASE_URL}/api/admin/metrics/export.csv?from=${D}&to=${D}&keys=dau,wau`, { headers: { Authorization: `Bearer ${await admin.jar.token()}`, 'x-forwarded-for': admin.jar.ip } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/csv')
      expect(res.headers.get('content-disposition')).toContain(`metrics-${D}-to-${D}.csv`)
      const lines = (await res.text()).trim().split('\r\n')
      expect(lines[0]).toBe('day,key,dimension,value,detail')
      expect(lines.slice(1)).toEqual([`${D},dau,,1,`, `${D},wau,,5,`])
      const denied = await req(member.jar, 'GET', `/api/admin/metrics/export.csv?from=${D}&to=${D}`)
      expect(denied.status).toBe(403)
    })

    it('runs as a job for a day, filling the people who were active first, and is safe to repeat', async () => {
      const first = await runSnapshot(testPrisma, { day: '2026-06-14', backfillDays: 5 })
      expect(first.day).toBe('2026-06-14')
      expect(first.failed).toEqual([])
      expect(first.rows).toBeGreaterThan(0)
      const second = await runSnapshot(testPrisma, { day: '2026-06-14', backfillDays: 5 })
      expect(second.rows).toBe(first.rows)
      expect(await testPrisma.metricsSnapshot.count({ where: { day: at('2026-06-14T00:00:00Z'), key: 'dau' } })).toBe(1)
      await testPrisma.metricsSnapshot.deleteMany({ where: { day: at('2026-06-14T00:00:00Z') } })
    }, 120_000)
  })
})
