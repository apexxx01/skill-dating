import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { registerAndLogin, uniqueSuffix, req, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'

// Every list endpoint takes `cursor` and answers `nextCursor`. For each one: walking
// the list by cursor visits every row exactly once and in the same order as the
// page-numbered answer, the page-numbered answer keeps `pagination` and gains
// `nextCursor`, a cursor request carries no `pagination`, and a bad cursor is a 400.
describe('cursor pagination', () => {
  const suffix = uniqueSuffix()
  let owner: TestUser
  let admin: TestUser
  const others: string[] = []
  let teamId: string
  let projectId: string

  async function get(user: TestUser, path: string) {
    const token = await user.jar.token()
    const res = await fetch(INTEGRATION_BASE_URL + path, { headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': user.jar.ip } })
    const text = await res.text()
    let data: any = null
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: res.status, data, headers: res.headers }
  }

  const withQuery = (path: string, params: Record<string, string | number | undefined>) => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&')
    return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path
  }

  /** Reads the rows and the next cursor out of either answer shape: `{ [key]: rows, nextCursor }` or a bare array plus a header. */
  const read = (res: Awaited<ReturnType<typeof get>>, key: string | null) => ({
    rows: (key ? res.data[key] : res.data) as { id: string }[],
    next: (key ? res.data.nextCursor : res.headers.get('x-next-cursor')) as string | null,
  })

  /** Walks the list with `limit` rows at a time and returns every id it saw. */
  async function walk(user: TestUser, path: string, key: string | null, limit = 2) {
    const ids: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 60; guard++) {
      const res = await get(user, withQuery(path, { limit, cursor }))
      expect(res.status, `${path} ${JSON.stringify(res.data).slice(0, 200)}`).toBe(200)
      const { rows, next } = read(res, key)
      expect(rows.length).toBeLessThanOrEqual(limit)
      ids.push(...rows.map((row) => row.id))
      if (cursor && key) expect(res.data.pagination, `${path} cursor answer`).toBeUndefined()
      if (!next) return ids
      cursor = next
    }
    throw new Error(`${path} never ended`)
  }

  async function checkList(user: TestUser, path: string, key: string | null, expectedCount: number, options: { ordered?: boolean } = {}) {
    // 50 is the largest page any of these lists allows.
    const bigPage = read(await get(user, withQuery(path, { limit: 50 })), key)
    expect(bigPage.rows.length, `${path}: rows in the list`).toBe(expectedCount)
    expect(bigPage.next).toBeNull()

    const walked = await walk(user, path, key)
    expect(new Set(walked).size, `${path}: no row twice`).toBe(walked.length)
    if (options.ordered === false) expect([...walked].sort(), `${path}: same rows`).toEqual(bigPage.rows.map((row) => row.id).sort())
    else expect(walked, `${path}: same rows, same order`).toEqual(bigPage.rows.map((row) => row.id))

    // Page-numbered requests keep working and hand out a cursor to continue with.
    const first = await get(user, withQuery(path, { limit: 2 }))
    const { next } = read(first, key)
    if (key) expect(first.data.pagination).toMatchObject({ page: 1, limit: 2, total: expectedCount })
    expect(next, `${path}: a cursor after page 1`).not.toBeNull()
    // Bare-array lists have no page numbers, only cursors.
    if (key) {
      const second = read(await get(user, withQuery(path, { limit: 2, page: 2 })), key)
      const continued = read(await get(user, withQuery(path, { limit: 2, cursor: next! })), key)
      expect(continued.rows.map((row) => row.id), `${path}: the cursor of page 1 gives page 2`).toEqual(second.rows.map((row) => row.id))
    }

    // A cursor that is not one of ours.
    const bad = await get(user, withQuery(path, { cursor: 'not-a-cursor' }))
    expect(bad.status, `${path}: bad cursor`).toBe(400)
    expect(bad.data.error.code).toBe('INVALID_CURSOR')
  }

  beforeAll(async () => {
    owner = await registerAndLogin(`pg.owner.${suffix}@test.dev`, `pgowner${suffix}`)
    admin = await registerAndLogin(`pg.admin.${suffix}@test.dev`, `pgadmin${suffix}`)
    await promoteToAdmin(admin.userId)

    // Local-only accounts for the other side of blocks, connections and so on.
    for (let index = 0; index < 5; index++) {
      const user = await testPrisma.user.create({
        data: { email: `pg.other${index}.${suffix}@test.dev`, username: `pgother${index}${suffix}`, name: `Pg Other ${index} ${suffix}`, xp: index < 3 ? 100 : 40 * index },
      })
      others.push(user.id)
    }
  }, 120_000)

  afterAll(async () => {
    await testPrisma.user.deleteMany({ where: { email: { contains: `pg.other` }, AND: { email: { contains: suffix } } } })
    await testPrisma.skill.deleteMany({ where: { slug: { contains: `pgskill-${suffix}` } } })
    await cleanupTestUsers(suffix)
  })

  it('projects', async () => {
    for (let index = 0; index < 5; index++) {
      const res = await req(owner.jar, 'POST', '/api/projects', { name: `Pg Project ${index} ${suffix}` })
      expect(res.status).toBe(201)
      projectId = res.data.id
    }
    await checkList(owner, `/api/projects?ownerId=${owner.userId}`, 'projects', 5)
  })

  it('activity', async () => {
    const total = await testPrisma.activity.count({ where: { userId: owner.userId } })
    expect(total).toBeGreaterThanOrEqual(5)
    await checkList(owner, '/api/activity', 'activity', total)
  })

  it('notifications', async () => {
    await testPrisma.notification.deleteMany({ where: { userId: owner.userId } })
    await testPrisma.notification.createMany({
      data: Array.from({ length: 7 }, (_, index) => ({ userId: owner.userId, type: 'SYSTEM' as const, title: `n${index}`, message: 'x', createdAt: new Date(Date.now() - (index % 3) * 1000) })),
    })
    await checkList(owner, '/api/notifications', 'notifications', 7)
  })

  it('milestones and project updates', async () => {
    for (let index = 0; index < 5; index++) {
      expect((await req(owner.jar, 'POST', `/api/projects/${projectId}/milestones`, { title: `m${index}` })).status).toBe(201)
      expect((await req(owner.jar, 'POST', `/api/projects/${projectId}/updates`, { title: `u${index}`, content: 'x' })).status).toBe(201)
    }
    await checkList(owner, `/api/projects/${projectId}/milestones`, 'milestones', 5)
    await checkList(owner, `/api/projects/${projectId}/updates`, 'updates', 5)
  })

  it('teams, team applications and the team applications list', async () => {
    for (let index = 0; index < 5; index++) {
      const res = await req(owner.jar, 'POST', '/api/teams', { name: `Pg Team ${index} ${suffix}` })
      expect(res.status).toBe(201)
      teamId = res.data.id
    }
    await checkList(owner, withQuery('/api/teams', { search: 'Pg Team' }), 'teams', 5)

    // Applications to the last team, from the local-only accounts.
    await testPrisma.teamApplication.createMany({ data: others.map((userId) => ({ userId, teamId, message: 'hi' })) })
    await checkList(owner, `/api/teams/${teamId}/applications`, null, 5)

    // The caller's own applications: owner applies to teams of a local account.
    const foreignTeams = await Promise.all(
      [0, 1, 2, 3].map((index) => testPrisma.team.create({ data: { name: `Pg Foreign ${index} ${suffix}`, slug: `pg-foreign-${index}-${suffix}`, ownerId: others[index] } }))
    )
    await testPrisma.teamApplication.createMany({ data: foreignTeams.map((team) => ({ userId: owner.userId, teamId: team.id, message: 'hi' })) })
    await checkList(owner, '/api/teams/applications', 'applications', 4)
  })

  it('hackathons and skills', async () => {
    for (let index = 0; index < 4; index++) {
      const res = await req(admin.jar, 'POST', '/api/hackathons', {
        name: `Pg Hackathon ${index} ${suffix}`,
        description: 'x',
        startDate: new Date(Date.now() + (index % 2) * 86400000 + 86400000).toISOString(),
        endDate: new Date(Date.now() + 5 * 86400000).toISOString(),
      })
      expect(res.status).toBe(201)
    }
    await checkList(owner, withQuery('/api/hackathons', { search: 'Pg Hackathon' }), 'hackathons', 4)

    await testPrisma.skill.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({ name: `Pgskill ${index} ${suffix}`, slug: `pgskill-${suffix}-${index}`, category: 'PgTest', order: index % 2 })),
    })
    await checkList(owner, `/api/skills?category=PgTest`, 'skills', 5)
  })

  it('evidence and the skills of a user', async () => {
    const skills = await testPrisma.skill.findMany({ where: { slug: { contains: `pgskill-${suffix}` } } })
    await testPrisma.userSkill.createMany({ data: skills.map((skill) => ({ userId: owner.userId, skillId: skill.id, level: 3 })) })
    for (let index = 0; index < 5; index++) {
      const res = await req(owner.jar, 'POST', '/api/evidence', { skillId: skills[0].id, type: 'PORTFOLIO', title: `Work ${index}`, url: 'https://example.com/x' })
      expect(res.status).toBe(201)
    }
    await checkList(owner, `/api/evidence?userId=${owner.userId}`, 'evidence', 5)

    // Answers with a bare array: the cursor travels in a header.
    const ids = await walk(owner, `/api/users/${owner.userId}/skills`, null)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    const bad = await get(owner, `/api/users/${owner.userId}/skills?cursor=nope`)
    expect(bad.status).toBe(400)
    expect(bad.data.error.code).toBe('INVALID_CURSOR')
    const whole = await get(owner, `/api/users/${owner.userId}/skills`)
    expect(Array.isArray(whole.data)).toBe(true)
    expect(whole.headers.get('x-next-cursor')).toBeNull()
  })

  it('blocks, connections and reports', async () => {
    await testPrisma.block.createMany({ data: others.slice(0, 4).map((blockedId) => ({ blockerId: owner.userId, blockedId })) })
    await checkList(owner, '/api/blocks', 'blocks', 4)

    await testPrisma.connection.createMany({ data: others.map((senderId) => ({ senderId, receiverId: admin.userId, type: 'NETWORK' as const })) })
    await checkList(admin, '/api/connections', 'connections', 5)

    await testPrisma.report.createMany({ data: others.map((reportedId) => ({ reporterId: admin.userId, reportedId, reason: 'SPAM' as const })) })
    const total = await testPrisma.report.count()
    await checkList(admin, '/api/reports', 'reports', total)
  })

  it('conversations and their messages', async () => {
    const conversations = []
    for (let index = 0; index < 4; index++) {
      conversations.push(
        await testPrisma.conversation.create({
          data: { type: 'GROUP', name: `Pg Chat ${index} ${suffix}`, members: { create: [{ userId: admin.userId, role: 'OWNER' }, { userId: others[index], role: 'MEMBER' }] } },
        })
      )
    }
    await checkList(admin, withQuery('/api/conversations', { search: 'Pg Chat' }), 'conversations', 4)

    const conversationId = conversations[0].id
    await testPrisma.message.createMany({
      data: Array.from({ length: 7 }, (_, index) => ({ conversationId, senderId: others[0], content: `m${index}`, createdAt: new Date(Date.now() - (index % 3) * 1000) })),
    })
    // Within a page the messages read oldest first, so only the set of rows is compared here.
    await checkList(admin, `/api/conversations/${conversationId}`, 'messages', 7, { ordered: false })
  })

  it('users and discover (people, ordered by XP and by compatibility)', async () => {
    // Two of the five share an XP value: the order among them must still be stable page to page.
    await checkList(admin, withQuery('/api/users', { search: 'Pg Other' }), 'users', 5)
    await checkList(admin, withQuery('/api/discover', { search: 'Pg Other' }), 'people', 5)
  })

  it('the leaderboard keeps ranks continuous across cursor pages', async () => {
    for (let index = 0; index < 5; index++) {
      await testPrisma.xPEvent.create({ data: { userId: others[index], type: 'PROJECT_CREATED', amount: 1_000_000 + (index < 2 ? 5 : index), description: 'seed' } })
    }
    // Viewed by the admin: the owner has blocked some of these people and would not see them.
    const first = await get(admin, '/api/leaderboard?limit=2')
    expect(first.status).toBe(200)
    expect(first.data.entries.map((entry: any) => entry.rank)).toEqual([1, 2])
    expect(first.data.pagination.total).toBeGreaterThanOrEqual(5)
    expect(first.data.nextCursor).not.toBeNull()

    const second = await get(admin, `/api/leaderboard?limit=2&cursor=${first.data.nextCursor}`)
    expect(second.data.entries.map((entry: any) => entry.rank)).toEqual([3, 4])
    expect(second.data.pagination).toBeUndefined()
    const seen = [...first.data.entries, ...second.data.entries].map((entry: any) => entry.user.id)
    expect(new Set(seen).size).toBe(4)

    // Equal XP keeps a single order: the same first page twice gives the same people.
    const again = await get(admin, '/api/leaderboard?limit=2')
    expect(again.data.entries.map((entry: any) => entry.user.id)).toEqual(first.data.entries.map((entry: any) => entry.user.id))
    expect((await get(admin, '/api/leaderboard?cursor=nope')).data.error.code).toBe('INVALID_CURSOR')
  })

  it('the admin flag list', async () => {
    for (let index = 0; index < 5; index++) {
      const res = await req(admin.jar, 'POST', '/api/admin/flags', { key: `pg-flag-${index}-${suffix}` })
      expect(res.status).toBe(201)
    }
    const ids: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 40; guard++) {
      const res = await get(admin, withQuery('/api/admin/flags', { limit: 3, cursor }))
      expect(res.status).toBe(200)
      ids.push(...res.data.flags.map((flag: any) => flag.key))
      if (!res.data.nextCursor) break
      cursor = res.data.nextCursor
    }
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((key) => key.endsWith(suffix))).toHaveLength(5)
    expect((await get(admin, '/api/admin/flags?cursor=nope')).data.error.code).toBe('INVALID_CURSOR')
    await testPrisma.featureFlag.deleteMany({ where: { key: { endsWith: suffix } } })
  })

  it('rejects limits above the cap instead of clamping', async () => {
    expect((await get(owner, '/api/projects?limit=51')).status).toBe(400)
    expect((await get(owner, '/api/projects?limit=0')).status).toBe(400)
  })
})
