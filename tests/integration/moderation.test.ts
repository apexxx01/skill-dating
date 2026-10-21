import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

// Moderation end to end: reports from any surface with a snapshot of what was said, the priority queue, report detail with context, actions (hide, restrict,
// suspend, ban) with their effects and notices, appeals reviewed by another moderator, staff permissions, and mutes.
describe('moderation', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let moderator: TestUser
  let moderator2: TestUser
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser
  let postId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`mda${suffix}@test.dev`, `mda${suffix}`)
    moderator = await registerAndLogin(`mdm${suffix}@test.dev`, `mdm${suffix}`)
    moderator2 = await registerAndLogin(`mdn${suffix}@test.dev`, `mdn${suffix}`)
    alice = await registerAndLogin(`mdx${suffix}@test.dev`, `mdx${suffix}`)
    bob = await registerAndLogin(`mdy${suffix}@test.dev`, `mdy${suffix}`)
    carol = await registerAndLogin(`mdz${suffix}@test.dev`, `mdz${suffix}`)
    await promoteToAdmin(admin.userId)
    await testPrisma.user.updateMany({ where: { id: { in: [moderator.userId, moderator2.userId] } }, data: { role: 'MODERATOR' } })
    const post = await req(bob.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Something rude', body: 'A post someone will report' })
    postId = post.data.post.id
  }, 180_000)

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 180_000)

  it('takes a report about a post, keeps what it said, and refuses what the reporter cannot see', async () => {
    const report = await req(alice.jar, 'POST', '/api/reports', { targetType: 'SHIP_POST', targetId: postId, reason: 'HARASSMENT', description: 'Rude' })
    expect(report.status).toBe(201)
    expect(report.data).toMatchObject({ targetType: 'SHIP_POST', targetId: postId, reportedId: bob.userId, reason: 'HARASSMENT', source: 'USER' })
    expect(report.data).not.toHaveProperty('priority')
    const row = await testPrisma.report.findUniqueOrThrow({ where: { id: report.data.id } })
    expect(row.snapshot).toMatchObject({ title: 'Something rude' })
    // Twice from one person is one open report.
    expect((await req(alice.jar, 'POST', '/api/reports', { targetType: 'SHIP_POST', targetId: postId, reason: 'SPAM' })).data.error.code).toBe('REPORT_ALREADY_PENDING')
    expect((await req(alice.jar, 'POST', '/api/reports', { targetType: 'COMMENT', targetId: 'nope', reason: 'SPAM' })).data.error.code).toBe('REPORT_TARGET_NOT_FOUND')
    expect((await req(bob.jar, 'POST', '/api/reports', { targetType: 'SHIP_POST', targetId: postId, reason: 'SPAM' })).data.error.code).toBe('CANNOT_REPORT_SELF')
    // A report about a person, as before.
    expect((await req(carol.jar, 'POST', '/api/reports', { reportedId: bob.userId, reason: 'IMPERSONATION' })).status).toBe(201)
  })

  it('orders the queue: minor safety first, impersonation above harassment, and more reporters move a report up', async () => {
    expect((await req(alice.jar, 'GET', '/api/admin/queue')).status).toBe(403)
    expect((await req(carol.jar, 'POST', '/api/reports', { reportedId: alice.userId, reason: 'MINOR_SAFETY', description: 'Says they are 15' })).status).toBe(201)
    const queue = await req(moderator.jar, 'GET', '/api/admin/queue?limit=50')
    expect(queue.status).toBe(200)
    const mine = queue.data.items.filter((item: any) => [alice.userId, bob.userId].includes(item.reportedId))
    expect(mine.map((item: any) => item.reason)).toEqual(['MINOR_SAFETY', 'IMPERSONATION', 'HARASSMENT'])

    const before = (await testPrisma.report.findFirstOrThrow({ where: { targetId: postId, reporterId: alice.userId } })).priority
    expect((await req(carol.jar, 'POST', '/api/reports', { targetType: 'SHIP_POST', targetId: postId, reason: 'HARASSMENT' })).status).toBe(201)
    expect((await testPrisma.report.findFirstOrThrow({ where: { targetId: postId, reporterId: alice.userId } })).priority).toBe(before + 40)
  })

  it('shows a moderator the report with its context, and marks it reviewing', async () => {
    const report = await testPrisma.report.findFirstOrThrow({ where: { targetId: postId, reporterId: alice.userId } })
    const detail = await req(moderator.jar, 'GET', `/api/admin/reports/${report.id}`)
    expect(detail.status).toBe(200)
    expect(detail.data.report.status).toBe('REVIEWING')
    expect(detail.data.target.asReported).toMatchObject({ title: 'Something rude' })
    expect(detail.data.priorReports.length).toBeGreaterThanOrEqual(1)
    expect(detail.data.risk.subject).toMatchObject({ effectiveLevel: 'LOW' })
  })

  it('hides the post for everyone, resolves every open report about it, and tells the author', async () => {
    const report = await testPrisma.report.findFirstOrThrow({ where: { targetId: postId, reporterId: alice.userId } })
    const acted = await req(moderator.jar, 'POST', '/api/admin/actions', { action: 'HIDE_CONTENT', targetType: 'SHIP_POST', targetId: postId, reportId: report.id, category: 'HARASSMENT', reason: 'Insults another member', noteToUser: 'Please keep it civil.' })
    expect(acted.status).toBe(201)
    expect((await req(alice.jar, 'GET', `/api/posts/${postId}`)).status).toBe(404)
    expect(await testPrisma.report.count({ where: { targetId: postId, status: { in: ['PENDING', 'REVIEWING'] } } })).toBe(0)
    const notice = await testPrisma.notification.findFirstOrThrow({ where: { userId: bob.userId, type: 'SYSTEM' }, orderBy: { createdAt: 'desc' } })
    expect(notice.title).toBe('A moderator hid something you posted')
    expect(notice.message).toContain('Please keep it civil.')
    expect(await testPrisma.auditEvent.count({ where: { action: 'MODERATION_ACTION', targetId: postId } })).toBe(1)
  })

  it('restricts one feature for a number of days', async () => {
    const acted = await req(moderator.jar, 'POST', '/api/admin/actions', { action: 'RESTRICT_FEATURE', feature: 'posting', durationDays: 3, targetType: 'USER', targetId: bob.userId, category: 'SPAM', reason: 'Posting spam' })
    expect(acted.status).toBe(201)
    const refused = await req(bob.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Again', body: 'More of it' })
    expect(refused.status).toBe(403)
    expect(refused.data.error).toMatchObject({ code: 'FEATURE_RESTRICTED', params: { feature: 'posting' } })
    // Everything else still works.
    expect((await req(bob.jar, 'GET', '/api/feed')).status).toBe(200)
    const lifted = await req(moderator.jar, 'POST', `/api/admin/actions/${acted.data.action.id}/reverse`, { reason: 'Mistake' })
    expect(lifted.status).toBe(200)
    expect((await req(bob.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Back again', body: 'A normal post' })).status).toBe(201)
  })

  it('suspends an account, which can still see what happened and appeal; another moderator overturns it', async () => {
    const acted = await req(moderator.jar, 'POST', '/api/admin/actions', { action: 'SUSPEND', durationDays: 7, targetType: 'USER', targetId: bob.userId, category: 'HARASSMENT', reason: 'Repeated harassment' })
    expect(acted.status).toBe(201)
    const closed = await req(bob.jar, 'GET', '/api/feed')
    expect(closed.status).toBe(403)
    expect(closed.data.error.code).toBe('ACCOUNT_SUSPENDED')
    expect((await req(bob.jar, 'GET', '/api/users/me')).status).toBe(200)

    const history = await req(bob.jar, 'GET', '/api/users/me/moderation')
    expect(history.data.state.suspendedUntil).not.toBeNull()
    const suspension = history.data.actions.find((a: any) => a.id === acted.data.action.id)
    expect(suspension).toMatchObject({ action: 'SUSPEND', category: 'HARASSMENT', canAppeal: true })
    expect(suspension).not.toHaveProperty('reason')

    expect((await req(bob.jar, 'POST', '/api/appeals', { actionId: acted.data.action.id, body: 'short' })).status).toBe(400)
    const appeal = await req(bob.jar, 'POST', '/api/appeals', { actionId: acted.data.action.id, body: 'I was replying to someone who insulted me first.' })
    expect(appeal.status).toBe(201)
    expect((await req(bob.jar, 'POST', '/api/appeals', { actionId: acted.data.action.id, body: 'Again, please look at it again.' })).data.error.code).toBe('APPEAL_EXISTS')
    expect((await req(alice.jar, 'POST', '/api/appeals', { actionId: acted.data.action.id, body: 'Not my action to appeal at all.' })).data.error.code).toBe('MODERATION_ACTION_NOT_FOUND')

    const appeals = await req(moderator2.jar, 'GET', '/api/admin/queue?kind=appeals')
    expect(appeals.data.items.map((item: any) => item.id)).toContain(appeal.data.appeal.id)
    // The moderator who acted does not decide the appeal.
    expect((await req(moderator.jar, 'POST', `/api/admin/appeals/${appeal.data.appeal.id}/decide`, { decision: 'OVERTURNED' })).status).toBe(403)
    const decided = await req(moderator2.jar, 'POST', `/api/admin/appeals/${appeal.data.appeal.id}/decide`, { decision: 'OVERTURNED', note: 'Context shows provocation' })
    expect(decided.status).toBe(200)
    expect((await req(bob.jar, 'GET', '/api/feed')).status).toBe(200)
    expect((await req(moderator2.jar, 'POST', `/api/admin/appeals/${appeal.data.appeal.id}/decide`, { decision: 'UPHELD' })).data.error.code).toBe('APPEAL_ALREADY_DECIDED')
  })

  it('bans with a recent sign-in, and only an admin acts on staff', async () => {
    expect((await req(moderator.jar, 'POST', '/api/admin/actions', { action: 'WARN', targetType: 'USER', targetId: moderator2.userId, category: 'OTHER', reason: 'Testing staff' })).status).toBe(403)
    const banned = await req(moderator.jar, 'POST', '/api/admin/actions', { action: 'BAN', targetType: 'USER', targetId: carol.userId, category: 'SCAM', reason: 'Scam messages' })
    expect(banned.status).toBe(201)
    const closed = await req(carol.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Hi there', body: 'x' })
    expect(closed.data.error.code).toBe('ACCOUNT_BANNED')
    expect((await req(admin.jar, 'POST', `/api/admin/actions/${banned.data.action.id}/reverse`, { reason: 'Cleanup' })).status).toBe(200)
  })

  it('finds people for staff, by e-mail for admins only, and shows the audit log to admins only', async () => {
    const byName = await req(moderator.jar, 'GET', `/api/admin/users?q=mdx${suffix}`)
    expect(byName.status).toBe(200)
    expect(byName.data.users[0]).toMatchObject({ id: alice.userId })
    expect(byName.data.users[0]).not.toHaveProperty('email')
    expect((await req(moderator.jar, 'GET', `/api/admin/users?q=mdx${suffix}@test.dev`)).status).toBe(403)
    const byEmail = await req(admin.jar, 'GET', `/api/admin/users?q=mdx${suffix}@test.dev`)
    expect(byEmail.data.users[0]).toMatchObject({ id: alice.userId, email: `mdx${suffix}@test.dev` })

    expect((await req(moderator.jar, 'GET', '/api/admin/audit')).status).toBe(403)
    const audit = await req(admin.jar, 'GET', `/api/admin/audit?targetId=${postId}`)
    expect(audit.status).toBe(200)
    expect(audit.data.events.map((e: any) => e.action)).toContain('MODERATION_ACTION')
    expect(audit.data.events[0]).not.toHaveProperty('ipAddress')
  })

  it('mutes without blocking: the muted person’s posts leave the muter’s feed, and nothing changes for them', async () => {
    const post = await req(bob.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Visible to most', body: 'Muted for one person' })
    expect((await req(alice.jar, 'POST', '/api/mutes', { userId: alice.userId })).data.error.code).toBe('CANNOT_MUTE_SELF')
    expect((await req(alice.jar, 'POST', '/api/mutes', { userId: bob.userId })).status).toBe(201)
    expect((await req(alice.jar, 'POST', '/api/mutes', { userId: bob.userId })).status).toBe(201)
    expect((await req(alice.jar, 'GET', '/api/mutes')).data.mutes.map((m: any) => m.user.id)).toEqual([bob.userId])
    expect((await req(alice.jar, 'GET', `/api/posts/${post.data.post.id}`)).status).toBe(404)
    // Not a block: bob still sees alice's things and can interact.
    expect((await req(bob.jar, 'GET', `/api/users/${alice.userId}`)).status).toBe(200)
    expect((await req(alice.jar, 'DELETE', `/api/mutes/${bob.userId}`)).data).toEqual({ muted: false, userId: bob.userId })
    expect((await req(alice.jar, 'GET', `/api/posts/${post.data.post.id}`)).status).toBe(200)
  })
})
