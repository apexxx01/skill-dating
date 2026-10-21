import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

// Content checks on what people write (src/lib/safety): hard terms refused everywhere, soft ones let through with a report for a moderator, repeated text
// refused, the first messages of a romance match without links or contact details, "who can message me", and the kill switches.
describe('content safety', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let ada: TestUser
  let ben: TestUser

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    admin = await registerAndLogin(`csa${suffix}@test.dev`, `csa${suffix}`)
    await promoteToAdmin(admin.userId)
    ada = await registerAndLogin(`csx${suffix}@test.dev`, `csx${suffix}`)
    ben = await registerAndLogin(`csy${suffix}@test.dev`, `csy${suffix}`)
  }, 120_000)

  afterAll(async () => {
    await testPrisma.featureFlag.updateMany({ where: { key: { startsWith: 'kill.' } }, data: { enabled: false } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  it('refuses a hard banned term in a post, a comment and a message', async () => {
    const post = await req(ada.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Free money', body: 'Guaranteed returns if you join now' })
    expect(post.status).toBe(400)
    expect(post.data.error).toMatchObject({ code: 'CONTENT_REJECTED', details: { reasons: ['BANNED_TERM'] } })
    const ok = await req(ada.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'Shipped it', body: 'A new parser, benchmarks inside' })
    expect(ok.status).toBe(201)
    expect((await req(ben.jar, 'POST', `/api/posts/${ok.data.post.id}/comments`, { body: 'send me your password and I will fix it' })).data.error.code).toBe('CONTENT_REJECTED')

    const conversation = await req(ada.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [ben.userId] })
    expect([200, 201]).toContain(conversation.status)
    expect((await req(ada.jar, 'POST', `/api/conversations/${conversation.data.id}`, { content: 'Please share your OTP with me' })).data.error.code).toBe('CONTENT_REJECTED')
  })

  it('lets a soft term through and files an automatic report for a moderator', async () => {
    const post = await req(ada.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'An offer', body: 'Have a look at this investment opportunity for builders' })
    expect(post.status).toBe(201)
    const report = await testPrisma.report.findFirstOrThrow({ where: { targetType: 'SHIP_POST', targetId: post.data.post.id } })
    expect(report).toMatchObject({ source: 'AUTOMATED', reporterId: null, reportedId: ada.userId })
    expect(await testPrisma.integritySignal.count({ where: { kind: 'CONTENT_FLAG', userId: ada.userId } })).toBe(1)
  })

  it('refuses the same text sent again and again', async () => {
    const conversation = await req(ben.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [ada.userId] })
    const send = () => req(ben.jar, 'POST', `/api/conversations/${conversation.data.id}`, { content: 'Check out my new launch today everyone' })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await send()).status)
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true)
    expect(statuses[5]).toBe(400)
  })

  it('honours "who can message me"', async () => {
    const carol = await registerAndLogin(`csz${suffix}@test.dev`, `csz${suffix}`)
    expect((await req(carol.jar, 'PATCH', '/api/users/me/privacy', { whoCanMessage: 'NOBODY' })).status).toBe(200)
    const refused = await req(ada.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [carol.userId] })
    expect(refused.status).toBe(403)
    expect(refused.data.error.code).toBe('MESSAGING_NOT_ALLOWED')
    expect((await req(carol.jar, 'PATCH', '/api/users/me/privacy', { whoCanMessage: 'EVERYONE' })).status).toBe(200)
    expect([200, 201]).toContain((await req(ada.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [carol.userId] })).status)
  })

  it('stops messaging and posting for everyone with their kill switches, with clear codes', async () => {
    const flip = (key: string, enabled: boolean) => req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { enabled })
    expect((await flip('kill.posting', true)).status).toBe(200)
    const post = await req(ada.jar, 'POST', '/api/posts', { kind: 'UPDATE', title: 'During the pause', body: 'x' })
    expect(post.status).toBe(503)
    expect(post.data.error.code).toBe('POSTING_PAUSED')
    expect((await req(ada.jar, 'GET', '/api/feed')).status).toBe(200)
    await flip('kill.posting', false)

    await flip('kill.messaging', true)
    expect((await req(ada.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [ben.userId] })).data.error.code).toBe('MESSAGING_PAUSED')
    await flip('kill.messaging', false)

    await flip('kill.romance', true)
    expect((await req(ada.jar, 'GET', '/api/romance/profile')).data.error.code).toBe('ROMANCE_PAUSED')
    await flip('kill.romance', false)

    await flip('kill.external-hackathons', true)
    expect((await req(ada.jar, 'POST', '/api/hackathons/external', { url: 'https://example.com/hack' })).data.error.code).toBe('EXTERNAL_HACKATHONS_PAUSED')
    await flip('kill.external-hackathons', false)
  })
})
