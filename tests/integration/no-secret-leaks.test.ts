import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix } from './helpers'
import { cleanupTestUsers, promoteToAdmin } from './db'

const BCRYPT_HASH = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/

// Walks every read endpoint (and the write responses that echo user data)
// after building a world in which users appear nested inside teams,
// projects, applications, conversations and connections - the shapes where
// an include-without-select would leak the whole user row. No response may
// contain a password hash, and no response one user receives may contain
// another user's email address.
describe('no secrets in any response', () => {
  const suffix = uniqueSuffix()

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  it('never exposes passwordHash or other users\' emails', async () => {
    const emailA = `leak.a.${suffix}@test.dev`
    const emailB = `leak.b.${suffix}@test.dev`
    const A = await registerAndLogin(emailA, `leaka${suffix}`)
    const B = await registerAndLogin(emailB, `leakb${suffix}`)
    await promoteToAdmin(A.userId)

    const project = await req(A.jar, 'POST', '/api/projects', { name: `Leak Project ${suffix}` })
    const projectId = project.data.id
    const team = await req(A.jar, 'POST', '/api/teams', { name: `Leak Team ${suffix}`, projectId })
    const teamId = team.data.id
    const application = await req(B.jar, 'POST', `/api/teams/${teamId}/applications`, {})
    await req(A.jar, 'PATCH', `/api/teams/${teamId}/applications/${application.data.id}`, { status: 'ACCEPTED' })
    await req(B.jar, 'POST', '/api/connections', { receiverId: A.userId, type: 'NETWORK' })
    await req(B.jar, 'POST', '/api/reports', { reportedId: A.userId, reason: 'SPAM' })
    await req(B.jar, 'PUT', '/api/builds/me', { title: `Leak Build ${suffix}` })

    const conversations = await req(A.jar, 'GET', '/api/conversations')
    const conversationList = conversations.data.conversations ?? conversations.data
    const conversationId = conversationList[0]?.id

    const paths = [
      '/api/users?limit=50',
      `/api/users/${B.userId}`,
      `/api/users/${A.userId}`,
      `/api/users/${B.userId}/skills`,
      '/api/discover?limit=50',
      '/api/leaderboard?limit=50',
      '/api/teams?limit=50',
      `/api/teams/${teamId}`,
      `/api/teams/${teamId}/applications`,
      `/api/teams/${teamId}/candidates`,
      '/api/teams/applications',
      '/api/projects?limit=50',
      `/api/projects/${projectId}`,
      '/api/hackathons',
      '/api/skills',
      '/api/notifications',
      '/api/connections',
      '/api/conversations',
      '/api/builds',
      '/api/reports',
      conversationId ? `/api/conversations/${conversationId}` : null,
    ].filter((p): p is string => Boolean(p))

    for (const path of paths) {
      const res = await req(A.jar, 'GET', path)
      expect(res.status, `${path} should succeed`).toBeLessThan(500)
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      expect(body, `${path} leaked passwordHash`).not.toContain('passwordHash')
      expect(body, `${path} leaked a bcrypt hash`).not.toMatch(BCRYPT_HASH)
      expect(body, `${path} leaked another user's email`).not.toContain(emailB)
    }

    // Write responses that echo user data.
    const patched = await req(A.jar, 'PATCH', '/api/users', { headline: 'hello' })
    const patchedBody = JSON.stringify(patched.data)
    expect(patchedBody).not.toContain('passwordHash')
    expect(patchedBody).not.toMatch(BCRYPT_HASH)

    // And the session endpoint must not carry the hash either.
    const session = await req(A.jar, 'GET', '/api/auth/session')
    expect(JSON.stringify(session.data)).not.toContain('passwordHash')
    expect(JSON.stringify(session.data)).not.toMatch(BCRYPT_HASH)
    // ...nor the caller's own local profile summary.
    const me = await req(A.jar, 'GET', '/api/users/me')
    expect(me.status).toBe(200)
    expect(JSON.stringify(me.data)).not.toContain('passwordHash')
    expect(JSON.stringify(me.data)).not.toMatch(BCRYPT_HASH)
  })
})
