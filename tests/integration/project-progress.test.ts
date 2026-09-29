import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'

// Project updates and milestones: access rules, IDOR, completion side effects
// and their idempotency/race safety, achievements, bounds and response hygiene.
describe('project progress', () => {
  const suffix = uniqueSuffix()
  const emails: string[] = []
  const bodies: string[] = []

  let owner: TestUser
  let member: TestUser
  let outsider: TestUser
  let racer: TestUser
  let admin: TestUser
  let publicProjectId: string
  let privateProjectId: string
  let otherProjectId: string

  // Every response body is remembered so the last test can assert nothing
  // anywhere leaked an email address or password hash.
  async function call(user: TestUser | null, method: string, path: string, body?: unknown) {
    const res = await req(user?.jar ?? null, method, path, body)
    bodies.push(typeof res.data === 'string' ? res.data : JSON.stringify(res.data))
    return res
  }

  async function makeUser(label: string) {
    const email = `progress.${label}.${suffix}@test.dev`
    emails.push(email)
    return registerAndLogin(email, `progress${label}${suffix}`)
  }

  async function makeProject(name: string, isPublic: boolean, members: TestUser[]) {
    const res = await call(owner, 'POST', '/api/projects', { name: `${name} ${suffix}`, isPublic })
    expect(res.status).toBe(201)
    for (const m of members) {
      await testPrisma.projectMember.create({ data: { userId: m.userId, projectId: res.data.id, role: 'MEMBER' } })
    }
    return res.data.id as string
  }

  beforeAll(async () => {
    owner = await makeUser('owner')
    member = await makeUser('member')
    outsider = await makeUser('outsider')
    racer = await makeUser('racer')
    admin = await makeUser('admin')
    await promoteToAdmin(admin.userId)

    publicProjectId = await makeProject('Public', true, [member, racer])
    privateProjectId = await makeProject('Private', false, [member])
    otherProjectId = await makeProject('Other', true, [member])
  })

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  const updatesPath = (projectId: string) => `/api/projects/${projectId}/updates`
  const milestonesPath = (projectId: string) => `/api/projects/${projectId}/milestones`

  async function newMilestone(projectId: string, user: TestUser = member, title = 'Ship the beta') {
    const res = await call(user, 'POST', milestonesPath(projectId), { title })
    expect(res.status).toBe(201)
    return res.data.id as string
  }

  describe('updates', () => {
    it('lets a member post, list, edit and delete their own update', async () => {
      const created = await call(member, 'POST', updatesPath(publicProjectId), { title: 'Week 1', content: 'Auth is done.' })
      expect(created.status).toBe(201)
      expect(created.data.type).toBe('UPDATE')
      expect(created.data.author.id).toBe(member.userId)

      const list = await call(member, 'GET', updatesPath(publicProjectId))
      expect(list.status).toBe(200)
      expect(list.data.updates.some((u: any) => u.id === created.data.id)).toBe(true)
      expect(list.data.pagination.total).toBeGreaterThanOrEqual(1)

      const edited = await call(member, 'PATCH', `${updatesPath(publicProjectId)}/${created.data.id}`, { content: 'Auth and billing.' })
      expect(edited.status).toBe(200)
      expect(edited.data.content).toBe('Auth and billing.')

      const removed = await call(member, 'DELETE', `${updatesPath(publicProjectId)}/${created.data.id}`)
      expect(removed.status).toBe(200)
      expect(await testPrisma.projectUpdate.count({ where: { id: created.data.id } })).toBe(0)
    })

    it('ignores client-supplied authorId/projectId and strips unknown keys', async () => {
      const created = await call(member, 'POST', updatesPath(publicProjectId), {
        title: 'Spoof',
        content: 'x',
        authorId: owner.userId,
        projectId: otherProjectId,
        createdAt: '2001-01-01T00:00:00.000Z',
      })
      expect(created.status).toBe(201)
      const row = await testPrisma.projectUpdate.findUniqueOrThrow({ where: { id: created.data.id } })
      expect(row.authorId).toBe(member.userId)
      expect(row.projectId).toBe(publicProjectId)
      expect(row.createdAt.getUTCFullYear()).not.toBe(2001)
    })

    it('only lets the author edit; the owner and admin may delete, other members may not', async () => {
      const created = await call(member, 'POST', updatesPath(publicProjectId), { title: 'Mine', content: 'mine' })
      const path = `${updatesPath(publicProjectId)}/${created.data.id}`

      expect((await call(racer, 'PATCH', path, { title: 'hijack' })).status).toBe(403)
      expect((await call(owner, 'PATCH', path, { title: 'owner edit' })).status).toBe(403)
      expect((await call(racer, 'DELETE', path)).status).toBe(403)

      expect((await call(owner, 'DELETE', path)).status).toBe(200)

      const second = await call(member, 'POST', updatesPath(publicProjectId), { title: 'Mine2', content: 'mine' })
      expect((await call(admin, 'DELETE', `${updatesPath(publicProjectId)}/${second.data.id}`)).status).toBe(200)
    })

    it('rejects system-generated update types from clients and refuses to edit system posts', async () => {
      for (const type of ['MILESTONE', 'SHIPPED', 'NONSENSE']) {
        const res = await call(member, 'POST', updatesPath(publicProjectId), { title: 't', content: 'c', type })
        expect(res.status, type).toBe(400)
      }
      const announcement = await call(member, 'POST', updatesPath(publicProjectId), { title: 'Big news', content: 'c', type: 'ANNOUNCEMENT' })
      expect(announcement.status).toBe(201)

      const system = await testPrisma.projectUpdate.create({
        data: { projectId: publicProjectId, authorId: member.userId, type: 'MILESTONE', title: 'system', content: 'system' },
      })
      const edit = await call(member, 'PATCH', `${updatesPath(publicProjectId)}/${system.id}`, { title: 'rewrite history' })
      expect(edit.status).toBe(400)
    })

    it('notifies the other members once and never the author', async () => {
      const before = await testPrisma.notification.count({ where: { type: 'PROJECT_UPDATE', userId: { in: [owner.userId, racer.userId, member.userId] } } })
      const memberBefore = await testPrisma.notification.count({ where: { type: 'PROJECT_UPDATE', userId: member.userId } })
      const created = await call(member, 'POST', updatesPath(publicProjectId), { title: 'Notify', content: 'c' })
      expect(created.status).toBe(201)
      const after = await testPrisma.notification.count({ where: { type: 'PROJECT_UPDATE', userId: { in: [owner.userId, racer.userId, member.userId] } } })
      expect(after - before).toBe(2) // owner + racer
      expect(await testPrisma.notification.count({ where: { type: 'PROJECT_UPDATE', userId: member.userId } })).toBe(memberBefore)
    })

    it('paginates newest first', async () => {
      const project = await makeProject('Paging', true, [member])
      for (const n of [1, 2, 3]) {
        await call(member, 'POST', updatesPath(project), { title: `u${n}`, content: 'c' })
      }
      const page1 = await call(member, 'GET', `${updatesPath(project)}?limit=2&page=1`)
      const page2 = await call(member, 'GET', `${updatesPath(project)}?limit=2&page=2`)
      expect(page1.data.updates.map((u: any) => u.title)).toEqual(['u3', 'u2'])
      expect(page2.data.updates.map((u: any) => u.title)).toEqual(['u1'])
      expect(page1.data.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 })
      expect((await call(member, 'GET', `${updatesPath(project)}?limit=500`)).status).toBe(400)
    })

    it('enforces title/content bounds', async () => {
      expect((await call(member, 'POST', updatesPath(publicProjectId), { title: 'x'.repeat(201), content: 'c' })).status).toBe(400)
      expect((await call(member, 'POST', updatesPath(publicProjectId), { title: 't', content: 'x'.repeat(10001) })).status).toBe(400)
      expect((await call(member, 'POST', updatesPath(publicProjectId), { title: '   ', content: 'c' })).status).toBe(400)
      expect((await call(member, 'POST', updatesPath(publicProjectId), {})).status).toBe(400)
    })
  })

  describe('milestones', () => {
    it('lets members create and edit, only the owner delete', async () => {
      const id = await newMilestone(publicProjectId)
      const path = `${milestonesPath(publicProjectId)}/${id}`

      const edited = await call(racer, 'PATCH', path, { title: 'Ship the GA', description: 'details', dueDate: '2030-06-01' })
      expect(edited.status).toBe(200)
      expect(edited.data.title).toBe('Ship the GA')
      expect(edited.data.completed).toBe(false)
      expect(new Date(edited.data.dueDate).toISOString().slice(0, 10)).toBe('2030-06-01')

      expect((await call(member, 'DELETE', path)).status).toBe(403)
      expect((await call(owner, 'DELETE', path)).status).toBe(200)
      expect(await testPrisma.milestone.count({ where: { id } })).toBe(0)
    })

    it('appends order and paginates', async () => {
      const project = await makeProject('Order', true, [member])
      const ids = [await newMilestone(project, member, 'a'), await newMilestone(project, member, 'b'), await newMilestone(project, member, 'c')]
      const list = await call(member, 'GET', milestonesPath(project))
      expect(list.data.milestones.map((m: any) => m.id)).toEqual(ids)
      expect(list.data.milestones.map((m: any) => m.order)).toEqual([0, 1, 2])
      const page = await call(member, 'GET', `${milestonesPath(project)}?limit=2&page=2`)
      expect(page.data.milestones).toHaveLength(1)
    })

    it('validates dueDate strictly', async () => {
      for (const dueDate of ['1', 'tomorrow', '2030-13-45', '9999-01-01', 12345]) {
        const res = await call(member, 'POST', milestonesPath(publicProjectId), { title: 't', dueDate })
        expect(res.status, String(dueDate)).toBe(400)
      }
      const ok = await call(member, 'POST', milestonesPath(publicProjectId), { title: 'dated', dueDate: '2031-01-15T10:00:00.000Z' })
      expect(ok.status).toBe(201)
      await call(owner, 'DELETE', `${milestonesPath(publicProjectId)}/${ok.data.id}`)
    })

    it('completes once: activity, achievement and announcement, idempotently', async () => {
      const project = await makeProject('Complete', true, [member])
      const id = await newMilestone(project, member, 'Launch')
      const path = `${milestonesPath(project)}/${id}`
      const activityWhere = { type: 'MILESTONE_COMPLETED', projectId: project }
      const announcements = () => testPrisma.projectUpdate.count({ where: { projectId: project, type: 'MILESTONE' } })

      const first = await call(member, 'PATCH', path, { completed: true })
      expect(first.status).toBe(200)
      expect(first.data.completed).toBe(true)
      const completedAt = first.data.completedAt

      expect(await testPrisma.activity.count({ where: activityWhere })).toBe(1)
      expect(await announcements()).toBe(1)
      const achievement = await testPrisma.achievement.findUniqueOrThrow({ where: { slug: 'first-milestone' } })
      expect(await testPrisma.userAchievement.count({ where: { userId: member.userId, achievementId: achievement.id } })).toBe(1)

      // completing again: no-op, timestamp and counts unchanged
      const again = await call(member, 'PATCH', path, { completed: true })
      expect(again.status).toBe(200)
      expect(again.data.completedAt).toBe(completedAt)
      expect(await testPrisma.activity.count({ where: activityWhere })).toBe(1)
      expect(await announcements()).toBe(1)

      // reopening clears the timestamp but keeps what already happened
      const reopened = await call(member, 'PATCH', path, { completed: false })
      expect(reopened.data.completed).toBe(false)
      expect(reopened.data.completedAt).toBeNull()
      expect(await testPrisma.activity.count({ where: activityWhere })).toBe(1)

      // completing it again is not announced a second time
      const recompleted = await call(member, 'PATCH', path, { completed: true })
      expect(recompleted.data.completed).toBe(true)
      expect(await testPrisma.activity.count({ where: activityWhere })).toBe(1)
      expect(await announcements()).toBe(1)

      // a second milestone by the same user is announced but earns no second achievement
      const second = await newMilestone(project, member, 'Follow-up')
      await call(member, 'PATCH', `${milestonesPath(project)}/${second}`, { completed: true })
      expect(await testPrisma.activity.count({ where: activityWhere })).toBe(2)
      expect(await testPrisma.userAchievement.count({ where: { userId: member.userId, achievementId: achievement.id } })).toBe(1)
    })

    it('runs the completion side effects exactly once under parallel completes', async () => {
      const project = await makeProject('Race', true, [racer])
      const id = await newMilestone(project, racer, 'Contended')
      const path = `${milestonesPath(project)}/${id}`

      const results = await Promise.all(Array.from({ length: 8 }, () => call(racer, 'PATCH', path, { completed: true })))
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200))

      expect(await testPrisma.activity.count({ where: { type: 'MILESTONE_COMPLETED', projectId: project } })).toBe(1)
      expect(await testPrisma.projectUpdate.count({ where: { projectId: project, type: 'MILESTONE' } })).toBe(1)
    })

    it('grants first-milestone once when one user completes different milestones in parallel', async () => {
      const fresh = await makeUser('fresh')
      const project = await makeProject('Race2', true, [fresh])
      const ids = await Promise.all([newMilestone(project, fresh, 'p1'), newMilestone(project, fresh, 'p2'), newMilestone(project, fresh, 'p3')])

      const results = await Promise.all(ids.map((id) => call(fresh, 'PATCH', `${milestonesPath(project)}/${id}`, { completed: true })))
      expect(results.map((r) => r.status)).toEqual([200, 200, 200])

      const achievement = await testPrisma.achievement.findUniqueOrThrow({ where: { slug: 'first-milestone' } })
      expect(await testPrisma.userAchievement.count({ where: { userId: fresh.userId, achievementId: achievement.id } })).toBe(1)
      expect(await testPrisma.activity.count({ where: { type: 'MILESTONE_COMPLETED', projectId: project } })).toBe(3)
    })

    it('holds the 100-milestone cap exactly under parallel creates', async () => {
      const project = await makeProject('Cap', true, [racer])
      await testPrisma.milestone.createMany({
        data: Array.from({ length: 98 }, (_, i) => ({ projectId: project, title: `bulk ${i}`, order: i })),
      })

      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call(racer, 'POST', milestonesPath(project), { title: `race ${i}` })))
      expect(results.filter((r) => r.status === 201)).toHaveLength(2)
      expect(results.filter((r) => r.status === 400)).toHaveLength(3)

      const rows = await testPrisma.milestone.findMany({ where: { projectId: project }, select: { order: true } })
      expect(rows).toHaveLength(100)
      expect(new Set(rows.map((r) => r.order)).size).toBe(100)
    })

    it('rejects an empty patch and unknown-only bodies', async () => {
      const id = await newMilestone(publicProjectId)
      const path = `${milestonesPath(publicProjectId)}/${id}`
      expect((await call(member, 'PATCH', path, {})).status).toBe(400)
      expect((await call(member, 'PATCH', path, { projectId: otherProjectId })).status).toBe(400)
      expect((await call(member, 'PATCH', path, { completed: 'yes' })).status).toBe(400)
      await call(owner, 'DELETE', path)
    })
  })

  describe('achievements', () => {
    it('grants first-update exactly once, including under parallel first posts', async () => {
      const fresh = await makeUser('poster')
      const project = await makeProject('Posts', true, [fresh])

      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => call(fresh, 'POST', updatesPath(project), { title: `p${i}`, content: 'c' }))
      )
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201])

      const achievement = await testPrisma.achievement.findUniqueOrThrow({ where: { slug: 'first-update' } })
      expect(await testPrisma.userAchievement.count({ where: { userId: fresh.userId, achievementId: achievement.id } })).toBe(1)
      expect(await testPrisma.activity.count({ where: { userId: fresh.userId, type: 'PROJECT_UPDATE_POSTED', projectId: project } })).toBe(4)
      expect(await testPrisma.activity.count({ where: { userId: fresh.userId, type: 'ACHIEVEMENT_EARNED' } })).toBe(1)
    })
  })

  describe('authorization', () => {
    it('rejects non-member writes on every write route, without leaking whether the row exists', async () => {
      const update = await call(member, 'POST', updatesPath(publicProjectId), { title: 'target', content: 'c' })
      const milestoneId = await newMilestone(publicProjectId)
      const updatePath = `${updatesPath(publicProjectId)}/${update.data.id}`
      const milestonePath = `${milestonesPath(publicProjectId)}/${milestoneId}`

      const attempts = [
        call(outsider, 'POST', updatesPath(publicProjectId), { title: 't', content: 'c' }),
        call(outsider, 'POST', milestonesPath(publicProjectId), { title: 't' }),
        call(outsider, 'PATCH', updatePath, { title: 'x' }),
        call(outsider, 'DELETE', updatePath),
        call(outsider, 'PATCH', milestonePath, { completed: true }),
        call(outsider, 'DELETE', milestonePath),
        // a non-existent child id must look the same to a non-member
        call(outsider, 'PATCH', `${updatesPath(publicProjectId)}/doesnotexist`, { title: 'x' }),
        call(outsider, 'DELETE', `${milestonesPath(publicProjectId)}/doesnotexist`),
      ]
      const statuses = (await Promise.all(attempts)).map((r) => r.status)
      expect(statuses).toEqual(Array(8).fill(403))

      // and nothing changed
      expect(await testPrisma.projectUpdate.count({ where: { id: update.data.id } })).toBe(1)
      const milestone = await testPrisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } })
      expect(milestone.completedAt).toBeNull()
      await call(owner, 'DELETE', milestonePath)
    })

    it('follows project visibility for reads', async () => {
      await call(member, 'POST', updatesPath(privateProjectId), { title: 'secret', content: 'c' })
      await newMilestone(privateProjectId)

      for (const path of [updatesPath(privateProjectId), milestonesPath(privateProjectId)]) {
        expect((await call(outsider, 'GET', path)).status, `outsider ${path}`).toBe(403)
        expect((await call(member, 'GET', path)).status, `member ${path}`).toBe(200)
        expect((await call(owner, 'GET', path)).status, `owner ${path}`).toBe(200)
      }
      for (const path of [updatesPath(publicProjectId), milestonesPath(publicProjectId)]) {
        expect((await call(outsider, 'GET', path)).status, `public ${path}`).toBe(200)
      }
    })

    it('returns 401 when unauthenticated', async () => {
      expect((await call(null, 'GET', updatesPath(publicProjectId))).status).toBe(401)
      expect((await call(null, 'POST', milestonesPath(publicProjectId), { title: 't' })).status).toBe(401)
    })

    it('treats an update or milestone addressed through another project as not found', async () => {
      const foreignUpdate = await call(owner, 'POST', updatesPath(otherProjectId), { title: 'foreign', content: 'c' })
      const foreignMilestone = await newMilestone(otherProjectId, owner)

      // `member` belongs to BOTH projects, so this is purely an id mixup
      const viaWrongProject = [
        call(member, 'PATCH', `${updatesPath(publicProjectId)}/${foreignUpdate.data.id}`, { title: 'x' }),
        call(owner, 'DELETE', `${updatesPath(publicProjectId)}/${foreignUpdate.data.id}`),
        call(member, 'PATCH', `${milestonesPath(publicProjectId)}/${foreignMilestone}`, { completed: true }),
        call(owner, 'DELETE', `${milestonesPath(publicProjectId)}/${foreignMilestone}`),
      ]
      expect((await Promise.all(viaWrongProject)).map((r) => r.status)).toEqual([404, 404, 404, 404])

      expect(await testPrisma.projectUpdate.count({ where: { id: foreignUpdate.data.id } })).toBe(1)
      const untouched = await testPrisma.milestone.findUniqueOrThrow({ where: { id: foreignMilestone } })
      expect(untouched.completedAt).toBeNull()
    })

    it('returns a clean 404 for garbage ids, never a 500', async () => {
      // '%E0%A4%A' is an invalid percent-escape: the framework itself answers
      // 400 before any handler runs, which is still a clean client error.
      const garbage = ['nope', 'x'.repeat(300), '%00', '..%2F..%2Fetc', "a'b", '%E0%A4%A']
      for (const id of garbage) {
        const results = await Promise.all([
          call(member, 'GET', updatesPath(id)),
          call(member, 'POST', milestonesPath(id), { title: 't' }),
          call(member, 'PATCH', `${updatesPath(publicProjectId)}/${id}`, { title: 'x' }),
          call(member, 'DELETE', `${updatesPath(publicProjectId)}/${id}`),
          call(member, 'PATCH', `${milestonesPath(publicProjectId)}/${id}`, { completed: true }),
          call(owner, 'DELETE', `${milestonesPath(publicProjectId)}/${id}`),
        ])
        const expected = id === '%E0%A4%A' ? [400, 404] : [404]
        for (const r of results) expect(expected, `${id} -> ${r.status}`).toContain(r.status)
      }
    })
  })

  it('never returns an email address or password hash', async () => {
    expect(bodies.length).toBeGreaterThan(20)
    for (const email of emails) {
      expect(bodies.filter((b) => b.includes(email)), email).toHaveLength(0)
    }
    expect(bodies.filter((b) => b.includes('passwordHash'))).toHaveLength(0)
    expect(bodies.filter((b) => /\$2[aby]\$\d{2}\$/.test(b))).toHaveLength(0)
  })
})
