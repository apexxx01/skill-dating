import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { req, registerAndLogin, uniqueSuffix, syntheticIp, type TestUser } from './helpers'
import { cleanupTestUsers } from './db'

// Every API error is { error: { code, message } } with a stable MACHINE_CODE.
// These check the contract end to end over HTTP, across the kinds of failure a
// client meets: no session, bad input, missing things, someone else's things.

describe('error contract', () => {
  const suffix = uniqueSuffix()
  let A: TestUser
  let B: TestUser

  beforeAll(async () => {
    A = await registerAndLogin(`errc.a.${suffix}@test.dev`, `errca${suffix}`)
    B = await registerAndLogin(`errc.b.${suffix}@test.dev`, `errcb${suffix}`)
  })

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  /** The shape every error must have. */
  function expectError(res: { status: number; data: any }, status: number, code: string) {
    expect(res.status).toBe(status)
    expect(Object.keys(res.data)).toEqual(['error'])
    expect(res.data.error.code).toBe(code)
    expect(typeof res.data.error.message).toBe('string')
    expect(res.data.error.message.length).toBeGreaterThan(0)
  }

  it('answers a missing session with UNAUTHORIZED', async () => {
    expectError(await req(null, 'GET', '/api/users/me'), 401, 'UNAUTHORIZED')
    expectError(await req(null, 'POST', '/api/projects', { name: 'x' }), 401, 'UNAUTHORIZED')
  })

  it('answers a malformed body with INVALID_JSON', async () => {
    const res = await fetch(INTEGRATION_BASE_URL + '/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await A.jar.token()}`, 'x-forwarded-for': A.jar.ip },
      body: '{not json',
    })
    expectError({ status: res.status, data: await res.json() }, 400, 'INVALID_JSON')
  })

  it('answers invalid input with VALIDATION_FAILED and the fields in details', async () => {
    const res = await req(A.jar, 'POST', '/api/teams', { name: '' })
    expectError(res, 400, 'VALIDATION_FAILED')
    expect(res.data.error.details).toHaveProperty('name')
    expect(Array.isArray(res.data.error.details.name)).toBe(true)
  })

  it('answers a missing thing with its own NOT_FOUND code', async () => {
    expectError(await req(A.jar, 'GET', '/api/teams/does-not-exist'), 404, 'TEAM_NOT_FOUND')
    expectError(await req(A.jar, 'GET', '/api/projects/does-not-exist'), 404, 'PROJECT_NOT_FOUND')
    expectError(await req(A.jar, 'GET', '/api/hackathons/does-not-exist'), 404, 'HACKATHON_NOT_FOUND')
  })

  it('answers someone else’s thing with FORBIDDEN', async () => {
    const team = await req(A.jar, 'POST', '/api/teams', { name: `Errc Team ${suffix}` })
    expect(team.status).toBe(201)
    expectError(await req(B.jar, 'DELETE', `/api/teams/${team.data.id}`), 403, 'FORBIDDEN')
  })

  it('answers a rule violation with a specific code', async () => {
    expectError(await req(A.jar, 'POST', '/api/blocks', { userId: A.userId }), 400, 'CANNOT_BLOCK_SELF')
    expectError(await req(A.jar, 'POST', '/api/connections', { receiverId: A.userId, type: 'TEAMMATE' }), 400, 'CANNOT_CONNECT_SELF')
  })

  it('carries parameters for messages that interpolate them', async () => {
    const sent = await req(A.jar, 'POST', '/api/connections', { receiverId: B.userId, type: 'TEAMMATE' })
    expect(sent.status).toBe(201)
    expect((await req(B.jar, 'PATCH', `/api/connections/${sent.data.id}`, { status: 'ACCEPTED' })).status).toBe(200)

    const again = await req(B.jar, 'PATCH', `/api/connections/${sent.data.id}`, { status: 'DECLINED' })
    expectError(again, 400, 'CONNECTION_ALREADY_RESOLVED')
    expect(again.data.error.params).toEqual({ status: 'accepted' })
    expect(again.data.error.message).toBe('Connection is already accepted')

    expectError(await req(A.jar, 'PATCH', '/api/connections/nope', { status: 'ACCEPTED' }), 404, 'CONNECTION_NOT_FOUND')
  })

  it('refuses an unsigned webhook delivery in the same shape', async () => {
    const res = await fetch(INTEGRATION_BASE_URL + '/api/webhooks/clerk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': syntheticIp() },
      body: '{}',
    })
    expectError({ status: res.status, data: await res.json() }, 400, 'WEBHOOK_SIGNATURE_MISSING')

    const bad = await fetch(INTEGRATION_BASE_URL + '/api/webhooks/clerk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': syntheticIp(), 'svix-id': 'a', 'svix-timestamp': '1', 'svix-signature': 'v1,x' },
      body: '{}',
    })
    expectError({ status: bad.status, data: await bad.json() }, 400, 'WEBHOOK_SIGNATURE_INVALID')
  })
})
