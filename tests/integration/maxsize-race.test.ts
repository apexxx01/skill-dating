import { describe, it, expect, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers } from './db'

// Turns this session's manual race repro into an automated regression test:
// a maxSize-3 team (owner + 2 open slots), 3 pending applications, 3 accepts
// fired concurrently. Exactly 2 must succeed and 1 must be cleanly rejected
// - never a 4th member sneaking in via a check-then-write race.
describe('team maxSize race safety', () => {
  const suffix = uniqueSuffix()

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  it('accepts exactly N-1 concurrent applications for a maxSize-N team, never more', async () => {
    const owner = await registerAndLogin(`maxrace.owner.${suffix}@test.dev`, `maxraceowner${suffix}`)
    const m1 = await registerAndLogin(`maxrace.m1.${suffix}@test.dev`, `maxracem1${suffix}`)
    const m2 = await registerAndLogin(`maxrace.m2.${suffix}@test.dev`, `maxracem2${suffix}`)
    const m3 = await registerAndLogin(`maxrace.m3.${suffix}@test.dev`, `maxracem3${suffix}`)

    let r = await req(owner.jar, 'POST', '/api/teams', { name: `MaxRace Team ${suffix}`, maxSize: 3 })
    expect(r.status).toBe(201)
    const teamId = r.data.id

    const applicants: TestUser[] = [m1, m2, m3]
    const appIds: string[] = []
    for (const applicant of applicants) {
      const applyRes = await req(applicant.jar, 'POST', `/api/teams/${teamId}/applications`, {})
      expect(applyRes.status).toBe(201)
      appIds.push(applyRes.data.id)
    }

    const results = await Promise.all(
      appIds.map((appId) => req(owner.jar, 'PATCH', `/api/teams/${teamId}/applications/${appId}`, { status: 'ACCEPTED' }))
    )

    const succeeded = results.filter((r) => r.status === 200).length
    const failed = results.filter((r) => r.status === 400).length

    expect(succeeded).toBe(2)
    expect(failed).toBe(1)

    const finalTeam = await req(owner.jar, 'GET', `/api/teams/${teamId}`)
    expect(finalTeam.data.members.length).toBe(3) // owner + 2, never 4
  })
})
