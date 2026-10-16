import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { req, registerAndLogin, uniqueSuffix, syntheticIp, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { jobs } from '../../src/lib/infra/jobs'

// The realtime token endpoint and the Inngest route, over HTTP. The server in
// this suite has no Ably or Inngest credentials, so it runs the in-process
// implementations: what is checked here is the policy (who gets which channels)
// and the wiring, not the providers.

describe('realtime token endpoint', () => {
  const suffix = uniqueSuffix()
  let A: TestUser
  let B: TestUser
  let C: TestUser
  let conversationId: string
  let teamId: string

  beforeAll(async () => {
    A = await registerAndLogin(`infra.a.${suffix}@test.dev`, `infraa${suffix}`)
    B = await registerAndLogin(`infra.b.${suffix}@test.dev`, `infrab${suffix}`)
    C = await registerAndLogin(`infra.c.${suffix}@test.dev`, `infrac${suffix}`)

    const conversation = await req(A.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [B.userId] })
    expect(conversation.status).toBe(201)
    conversationId = conversation.data.id

    const team = await req(A.jar, 'POST', '/api/teams', { name: `Infra Team ${suffix}` })
    expect(team.status).toBe(201)
    teamId = team.data.id
  })

  afterAll(async () => {
    await testPrisma.team.deleteMany({ where: { id: teamId } })
    await cleanupTestUsers(suffix)
  })

  const capability = (res: { data: any }) => JSON.parse(res.data.tokenRequest.capability)

  it('requires a signed-in user', async () => {
    const res = await req(null, 'POST', '/api/realtime/token')
    expect(res.status).toBe(401)
    expect(res.data.error.code).toBe('UNAUTHORIZED')
  })

  it('with no body, grants subscribe on the user’s own channel only', async () => {
    const res = await req(A.jar, 'POST', '/api/realtime/token')
    expect(res.status).toBe(200)
    expect(res.data.channels).toEqual([`user:${A.userId}`])
    expect(capability(res)).toEqual({ [`user:${A.userId}`]: ['subscribe'] })
    expect(res.data.tokenRequest.clientId).toBe(A.userId)
    expect(typeof res.data.expiresAt).toBe('string')
  })

  it('grants the conversations and teams the user belongs to', async () => {
    const channels = [`user:${A.userId}`, `conversation:${conversationId}`, `team:${teamId}`]
    const res = await req(A.jar, 'POST', '/api/realtime/token', { channels })
    expect(res.status).toBe(200)
    expect(Object.keys(capability(res)).sort()).toEqual([...channels].sort())
    for (const grants of Object.values(capability(res))) expect(grants).toEqual(['subscribe'])
  })

  it('grants a member of the conversation that conversation, and nobody else', async () => {
    const asMember = await req(B.jar, 'POST', '/api/realtime/token', { channels: [`conversation:${conversationId}`] })
    expect(asMember.status).toBe(200)

    const asOutsider = await req(C.jar, 'POST', '/api/realtime/token', { channels: [`conversation:${conversationId}`] })
    expect(asOutsider.status).toBe(403)
    expect(asOutsider.data.error.code).toBe('CHANNEL_FORBIDDEN')
    expect(asOutsider.data.error.details.denied).toEqual([`conversation:${conversationId}`])
    expect(JSON.stringify(asOutsider.data)).not.toContain('tokenRequest')
  })

  it('refuses someone else’s user channel, a team the user is not on, wildcards and unknown kinds', async () => {
    for (const channel of [`user:${A.userId}`, `team:${teamId}`, 'user:*', '*', 'admin:all']) {
      const res = await req(B.jar, 'POST', '/api/realtime/token', { channels: [channel] })
      expect(res.status, channel).toBe(403)
      expect(res.data.error.code, channel).toBe('CHANNEL_FORBIDDEN')
    }
  })

  it('does not issue anything when any one requested channel is refused', async () => {
    const res = await req(A.jar, 'POST', '/api/realtime/token', { channels: [`user:${A.userId}`, `user:${B.userId}`] })
    expect(res.status).toBe(403)
    expect(res.data.tokenRequest).toBeUndefined()
  })

  it('rejects a malformed request', async () => {
    const tooMany = await req(A.jar, 'POST', '/api/realtime/token', { channels: Array.from({ length: 21 }, (_, i) => `user:${i}`) })
    expect(tooMany.status).toBe(400)
    expect(tooMany.data.error.code).toBe('VALIDATION_FAILED')

    const notArray = await req(A.jar, 'POST', '/api/realtime/token', { channels: 'user:x' })
    expect(notArray.status).toBe(400)

    const broken = await fetch(INTEGRATION_BASE_URL + '/api/realtime/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${await A.jar.token()}`, 'x-forwarded-for': A.jar.ip },
      body: '{oops',
    })
    expect(broken.status).toBe(400)
    expect((await broken.json()).error.code).toBe('INVALID_JSON')
  })

  it('never reveals a signing key', async () => {
    const res = await req(A.jar, 'POST', '/api/realtime/token')
    expect(JSON.stringify(res.data)).not.toMatch(/secret|ABLY_API_KEY/i)
  })
})

describe('Inngest route', () => {
  it('answers an introspection request and lists the registered functions', async () => {
    const res = await fetch(INTEGRATION_BASE_URL + '/api/inngest', { headers: { 'x-forwarded-for': syntheticIp() } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.function_count).toBe(Object.keys(jobs).length)
    expect(body.function_count).toBeGreaterThanOrEqual(3)
    expect(body.has_event_key).toBe(false)
    expect(body.has_signing_key).toBe(false)
  })
})
