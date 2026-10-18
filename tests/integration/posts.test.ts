import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

// Posts, Props, comments, follows, watches, the feed, the timelines and Ship Day, through the real routes.
describe('posts and the feed', () => {
  const suffix = uniqueSuffix()
  let n = 0

  beforeAll(() => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 120_000)

  /** A signed-in, established account; `verified` gives it a verified login so its Props carry weight. */
  async function person(label: string, over: { verified?: boolean; timezone?: string } = {}): Promise<TestUser> {
    const name = `po${label}${suffix}${n++}`
    const u = await registerAndLogin(`${name}@test.dev`, name)
    await testPrisma.user.update({ where: { id: u.userId }, data: { verificationLevel: over.verified === false ? 'NONE' : 'EMAIL', ...(over.timezone ? { timezone: over.timezone } : {}) } })
    return u
  }
  const project = async (owner: TestUser, over: Record<string, unknown> = {}) => (await req(owner.jar, 'POST', '/api/projects', { name: `Post Project ${n++} ${suffix}`, ...over })).data.id as string
  const post = (u: TestUser, body: Record<string, unknown> = {}) => req(u.jar, 'POST', '/api/posts', { kind: 'DEMO', title: `A demo ${n++}`, body: 'Here is **what** I built.', ...body })
  const xp = async (userId: string, type: string) => (await testPrisma.xPEvent.findMany({ where: { userId, type } })).reduce((sum, row) => sum + row.amount, 0)

  describe('creating, reading, editing and deleting', () => {
    it('needs a signed-in user and a well-formed body', async () => {
      expect((await req(null, 'POST', '/api/posts', {})).status).toBe(401)
      expect((await req(null, 'GET', '/api/feed')).status).toBe(401)
      expect((await req(null, 'GET', '/api/ship-day')).status).toBe(401)
      const a = await person('v')
      for (const body of [{}, { kind: 'NOPE', title: 'abc', body: 'x' }, { kind: 'DEMO', title: 'ab', body: 'x' }, { kind: 'DEMO', title: 'abc', body: '' }, { kind: 'DEMO', title: 'abc', body: 'x', extra: 1 }, { kind: 'DEMO', title: 'abc', body: 'x', links: ['javascript:alert(1)'] }]) {
        const res = await req(a.jar, 'POST', '/api/posts', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
    })

    it('creates a post with sanitized markdown, then shows, edits (counting a revision) and soft-deletes it', async () => {
      const a = await person('c')
      const created = await post(a, { body: 'Hello <script>alert(1)</script> **bold** [ok](https://example.com) [bad](javascript:alert(1))' })
      expect(created.status).toBe(201)
      const { id, body } = created.data.post
      expect(body).not.toContain('<script')
      expect(body).not.toContain('javascript:')
      expect(body).toContain('**bold**')
      expect(created.data.post).toMatchObject({ kind: 'DEMO', visibility: 'PUBLIC', propsScore: 0, commentCount: 0, revision: 0, editedAt: null, yourProps: false })
      expect(created.data.shipped).toBe(false)

      expect((await req(a.jar, 'GET', `/api/posts/${id}`)).data.post.id).toBe(id)
      const edited = await req(a.jar, 'PATCH', `/api/posts/${id}`, { title: 'A better title' })
      expect(edited.status).toBe(200)
      expect(edited.data.post).toMatchObject({ title: 'A better title', revision: 1 })
      expect(edited.data.post.editedAt).not.toBeNull()
      expect((await req(a.jar, 'PATCH', `/api/posts/${id}`, { kind: 'SHIP' })).status).toBe(400)

      const other = await person('c2')
      expect((await req(other.jar, 'PATCH', `/api/posts/${id}`, { title: 'Mine now' })).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(other.jar, 'DELETE', `/api/posts/${id}`)).data.error.code).toBe('POST_NOT_FOUND')

      expect((await req(a.jar, 'DELETE', `/api/posts/${id}`)).data).toEqual({ deleted: true })
      expect((await req(a.jar, 'GET', `/api/posts/${id}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(a.jar, 'DELETE', `/api/posts/${id}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(other.jar, 'GET', `/api/posts/${id}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect(await testPrisma.shipPost.count({ where: { id } })).toBe(1) // soft delete: the row stays
    })

    it('answers a repeated Idempotency-Key with the first result and makes one post', async () => {
      const a = await person('i')
      const key = `post-${suffix}-${n++}`
      const first = await req(a.jar, 'POST', '/api/posts', { kind: 'DEMO', title: 'Once only', body: 'x' }, { 'Idempotency-Key': key })
      const second = await req(a.jar, 'POST', '/api/posts', { kind: 'DEMO', title: 'Once only', body: 'x' }, { 'Idempotency-Key': key })
      expect(first.status).toBe(201)
      expect(second.data.post.id).toBe(first.data.post.id)
      expect(await testPrisma.shipPost.count({ where: { authorId: a.userId } })).toBe(1)
    })

    it('needs the author to belong to the project, and a SHIP post to name one', async () => {
      const owner = await person('m')
      const stranger = await person('m2')
      const projectId = await project(owner)
      expect((await post(stranger, { projectId })).data.error.code).toBe('POST_INVALID_CONTEXT')
      expect((await post(owner, { kind: 'SHIP' })).data.error.code).toBe('POST_INVALID_CONTEXT')
      expect((await post(owner, { visibility: 'CREW' })).data.error.code).toBe('POST_INVALID_CONTEXT')
      expect((await post(owner, { projectId, coAuthorIds: [stranger.userId] })).data.error.code).toBe('POST_COAUTHOR_NOT_MEMBER')
      expect((await post(owner, { projectId: 'nope' })).data.error.code).toBe('POST_INVALID_CONTEXT')
    })

    it('ships a project once through a SHIP post, and only the first one pays', async () => {
      const a = await person('s')
      const projectId = await project(a)
      const first = await post(a, { kind: 'SHIP', projectId, title: 'We shipped it' })
      expect(first.status).toBe(201)
      expect(first.data.shipped).toBe(true)
      expect((await testPrisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('SHIPPED')
      const afterFirst = await xp(a.userId, 'PROJECT_SHIP')
      expect(afterFirst).toBeGreaterThan(0)
      const second = await post(a, { kind: 'SHIP', projectId, title: 'Shipped it again' })
      expect(second.status).toBe(201)
      expect(second.data.shipped).toBe(false)
      expect(await xp(a.userId, 'PROJECT_SHIP')).toBe(afterFirst)
    })

    it('counts an UPDATE post as a project update, and a DEMO as none', async () => {
      const a = await person('u')
      const projectId = await project(a)
      expect((await post(a, { kind: 'UPDATE', projectId, title: 'Week one' })).status).toBe(201)
      expect((await post(a, { kind: 'DEMO', projectId, title: 'A demo' })).status).toBe(201)
      expect(await testPrisma.projectUpdate.count({ where: { projectId } })).toBe(1)
      expect(await xp(a.userId, 'PROJECT_UPDATE_POSTED')).toBeGreaterThan(0)
    })

    it('credits co-authors who belong to the project and shows the post on their timeline', async () => {
      const owner = await person('co')
      const mate = await person('co2')
      const projectId = await project(owner)
      await testPrisma.projectMember.create({ data: { projectId, userId: mate.userId } })
      const made = await post(owner, { projectId, coAuthorIds: [mate.userId] })
      expect(made.status).toBe(201)
      expect(made.data.post.coAuthors.map((p: { id: string }) => p.id)).toEqual([mate.userId])
      const theirs = await req(owner.jar, 'GET', `/api/users/${mate.userId}/posts`)
      expect(theirs.data.posts.map((p: { id: string }) => p.id)).toContain(made.data.post.id)
      // A co-author shares the credit, not the pen.
      expect((await req(mate.jar, 'PATCH', `/api/posts/${made.data.post.id}`, { title: 'Changed' })).data.error.code).toBe('FORBIDDEN')
    })
  })

  describe('visibility and blocks', () => {
    it('shows FOLLOWERS posts to followers only and CREW posts to project members only', async () => {
      const author = await person('vis')
      const follower = await person('vis2')
      const stranger = await person('vis3')
      const projectId = await project(author)
      const followersOnly = (await post(author, { visibility: 'FOLLOWERS' })).data.post.id
      const crewOnly = (await post(author, { visibility: 'CREW', projectId })).data.post.id
      for (const id of [followersOnly, crewOnly]) expect((await req(follower.jar, 'GET', `/api/posts/${id}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(follower.jar, 'POST', `/api/users/${author.userId}/follow`)).status).toBe(201)
      expect((await req(follower.jar, 'GET', `/api/posts/${followersOnly}`)).status).toBe(200)
      expect((await req(follower.jar, 'GET', `/api/posts/${crewOnly}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(stranger.jar, 'GET', `/api/posts/${followersOnly}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(author.jar, 'GET', `/api/posts/${crewOnly}`)).status).toBe(200)
      const timeline = await req(stranger.jar, 'GET', `/api/users/${author.userId}/posts`)
      expect(timeline.data.posts).toEqual([])
    })

    it('hides a blocked person’s posts both ways and refuses Props, comments and follows between them', async () => {
      const a = await person('bl')
      const b = await person('bl2')
      const made = (await post(a)).data.post.id
      expect((await req(b.jar, 'POST', '/api/blocks', { userId: a.userId })).status).toBeLessThan(300)
      expect((await req(b.jar, 'GET', `/api/posts/${made}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(b.jar, 'POST', `/api/posts/${made}/props`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(b.jar, 'POST', `/api/posts/${made}/comments`, { body: 'hi' })).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(a.jar, 'POST', `/api/posts/${made}/props`)).data.error.code).toBe('CANNOT_PROP_OWN_POST')
      const mine = (await post(b)).data.post.id
      expect((await req(a.jar, 'GET', `/api/posts/${mine}`)).data.error.code).toBe('POST_NOT_FOUND')
      expect((await req(a.jar, 'POST', `/api/users/${b.userId}/follow`)).data.error.code).toBe('USER_NOT_FOUND')
      expect((await req(b.jar, 'POST', `/api/users/${a.userId}/follow`)).data.error.code).toBe('USER_BLOCKED')
      const feed = await req(b.jar, 'GET', '/api/feed')
      expect(feed.data.posts.map((p: { id: string }) => p.id)).not.toContain(made)
    })
  })

  describe('Props', () => {
    it('weights a Prop by the giver, stores it once, never on your own post, and pays the author once per giver', async () => {
      const author = await person('pr')
      const giver = await person('pr2')
      const made = (await post(author)).data.post.id
      expect((await req(author.jar, 'POST', `/api/posts/${made}/props`)).data.error.code).toBe('CANNOT_PROP_OWN_POST')
      const first = await req(giver.jar, 'POST', `/api/posts/${made}/props`)
      expect(first.status).toBe(201)
      expect(first.data).toMatchObject({ propsCount: 1, yourProps: true, created: true })
      expect(first.data.propsScore).toBeGreaterThan(0)
      const row = await testPrisma.prop.findFirstOrThrow({ where: { postId: made, userId: giver.userId } })
      expect(row.weight).toBe(first.data.propsScore)
      expect(await xp(author.userId, 'PROPS_RECEIVED')).toBe(2)

      const again = await req(giver.jar, 'POST', `/api/posts/${made}/props`)
      expect(again.status).toBe(200)
      expect(again.data).toMatchObject({ propsCount: 1, created: false, propsScore: first.data.propsScore })
      expect(await xp(author.userId, 'PROPS_RECEIVED')).toBe(2)

      const taken = await req(giver.jar, 'DELETE', `/api/posts/${made}/props`)
      expect(taken.data).toMatchObject({ propsCount: 0, propsScore: 0, yourProps: false })
      // XP already paid is not clawed back, and giving again pays nothing new.
      expect(await xp(author.userId, 'PROPS_RECEIVED')).toBe(2)
      await req(giver.jar, 'POST', `/api/posts/${made}/props`)
      expect(await xp(author.userId, 'PROPS_RECEIVED')).toBe(2)
      expect((await req(giver.jar, 'POST', '/api/posts/nope/props')).data.error.code).toBe('POST_NOT_FOUND')
    })

    it('gives an unverified giver no weight and the author no XP', async () => {
      const author = await person('pw')
      const giver = await person('pw2', { verified: false })
      const made = (await post(author)).data.post.id
      const res = await req(giver.jar, 'POST', `/api/posts/${made}/props`)
      expect(res.status).toBe(201)
      expect(res.data).toMatchObject({ propsScore: 0, propsCount: 1 })
      expect(await xp(author.userId, 'PROPS_RECEIVED')).toBe(0)
    })
  })

  describe('comments', () => {
    it('lists one level of replies, refuses a reply to a reply, edits inside the window and soft-deletes', async () => {
      const author = await person('cm')
      const reader = await person('cm2')
      const made = (await post(author)).data.post.id
      expect((await req(reader.jar, 'POST', `/api/posts/${made}/comments`, {})).status).toBe(400)
      expect((await req(reader.jar, 'POST', `/api/posts/${made}/comments`, { body: 'x'.repeat(2001) })).status).toBe(400)
      const top = await req(reader.jar, 'POST', `/api/posts/${made}/comments`, { body: 'Nice work' })
      expect(top.status).toBe(201)
      const reply = await req(author.jar, 'POST', `/api/posts/${made}/comments`, { body: 'Thanks!', parentId: top.data.comment.id })
      expect(reply.status).toBe(201)
      expect((await req(reader.jar, 'POST', `/api/posts/${made}/comments`, { body: 'Deeper', parentId: reply.data.comment.id })).data.error.code).toBe('COMMENT_REPLY_DEPTH')
      expect((await req(reader.jar, 'POST', `/api/posts/${made}/comments`, { body: 'Lost', parentId: 'nope' })).data.error.code).toBe('COMMENT_NOT_FOUND')

      const listed = await req(author.jar, 'GET', `/api/posts/${made}/comments`)
      expect(listed.data.comments).toHaveLength(1)
      expect(listed.data.comments[0].replies.map((r: { body: string }) => r.body)).toEqual(['Thanks!'])
      expect((await req(author.jar, 'GET', `/api/posts/${made}`)).data.post.commentCount).toBe(2)

      expect((await req(reader.jar, 'PATCH', `/api/comments/${top.data.comment.id}`, { body: 'Nice work, really' })).data.comment.body).toBe('Nice work, really')
      expect((await req(author.jar, 'PATCH', `/api/comments/${top.data.comment.id}`, { body: 'Mine' })).data.error.code).toBe('COMMENT_NOT_FOUND')
      await testPrisma.comment.update({ where: { id: top.data.comment.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } })
      const late = await req(reader.jar, 'PATCH', `/api/comments/${top.data.comment.id}`, { body: 'Too late' })
      expect(late.status).toBe(403)
      expect(late.data.error.code).toBe('COMMENT_EDIT_WINDOW_CLOSED')
      expect(late.data.error.message).toContain('15')

      expect((await req(author.jar, 'DELETE', `/api/comments/${reply.data.comment.id}`)).data).toEqual({ deleted: true })
      expect((await req(author.jar, 'DELETE', `/api/comments/${reply.data.comment.id}`)).data.error.code).toBe('COMMENT_NOT_FOUND')
      expect((await req(author.jar, 'GET', `/api/posts/${made}`)).data.post.commentCount).toBe(1)
    })

    it('coalesces comment notifications for one post into one', async () => {
      const author = await person('cn')
      const reader = await person('cn2')
      const made = (await post(author)).data.post.id
      for (const text of ['one', 'two', 'three']) await req(reader.jar, 'POST', `/api/posts/${made}/comments`, { body: text })
      const rows = await testPrisma.notification.findMany({ where: { userId: author.userId, type: 'COMMENT' } })
      expect(rows).toHaveLength(1)
      expect(rows[0].count).toBe(3)
      expect(rows[0].message).toContain('3')
    })
  })

  describe('follows and watches', () => {
    it('follows, lists, repeats harmlessly, and refuses following yourself', async () => {
      const a = await person('f')
      const b = await person('f2')
      expect((await req(a.jar, 'POST', `/api/users/${a.userId}/follow`)).data.error.code).toBe('CANNOT_FOLLOW_SELF')
      expect((await req(a.jar, 'POST', '/api/users/nope/follow')).data.error.code).toBe('USER_NOT_FOUND')
      expect((await req(a.jar, 'POST', `/api/users/${b.userId}/follow`)).status).toBe(201)
      expect((await req(a.jar, 'POST', `/api/users/${b.userId}/follow`)).status).toBe(200)
      expect(await testPrisma.follow.count({ where: { followerId: a.userId } })).toBe(1)
      const followers = await req(b.jar, 'GET', `/api/users/${b.userId}/followers`)
      expect(followers.data.people.map((p: { id: string }) => p.id)).toEqual([a.userId])
      const following = await req(a.jar, 'GET', `/api/users/${a.userId}/following`)
      expect(following.data.people.map((p: { id: string }) => p.id)).toEqual([b.userId])
      expect((await req(a.jar, 'GET', `/api/users/${b.userId}/followers?cursor=garbage`)).data.error.code).toBe('INVALID_CURSOR')
      expect((await req(a.jar, 'DELETE', `/api/users/${b.userId}/follow`)).data).toEqual({ following: false })
      expect((await req(a.jar, 'DELETE', `/api/users/${b.userId}/follow`)).data).toEqual({ following: false })
      expect(await testPrisma.follow.count({ where: { followerId: a.userId } })).toBe(0)
    })

    it('watches a project and is told once about its posts; a private project cannot be watched by an outsider', async () => {
      const owner = await person('w')
      const watcher = await person('w2')
      const outsider = await person('w3')
      const projectId = await project(owner)
      const hidden = await project(owner, { isPublic: false })
      expect((await req(watcher.jar, 'POST', `/api/projects/${projectId}/watch`)).status).toBe(201)
      expect((await req(watcher.jar, 'POST', `/api/projects/${projectId}/watch`)).status).toBe(200)
      expect((await req(outsider.jar, 'POST', `/api/projects/${hidden}/watch`)).data.error.code).toBe('PROJECT_NOT_FOUND')
      expect((await req(outsider.jar, 'GET', `/api/projects/${hidden}/timeline`)).data.error.code).toBe('PROJECT_NOT_FOUND')
      const made = await post(owner, { projectId, kind: 'UPDATE', title: 'News' })
      expect(made.status).toBe(201)
      // The job runs in memory in tests: give it a moment, then read the notification.
      const { notifyWatchers } = await import('../../src/lib/posts/watchers')
      await notifyWatchers(testPrisma, made.data.post.id)
      await notifyWatchers(testPrisma, made.data.post.id)
      const rows = await testPrisma.notification.findMany({ where: { userId: watcher.userId, type: 'WATCH' } })
      expect(rows.length).toBe(1)
      const timeline = await req(watcher.jar, 'GET', `/api/projects/${projectId}/timeline`)
      expect(timeline.data.posts.map((p: { id: string }) => p.id)).toEqual([made.data.post.id])
      expect((await req(watcher.jar, 'DELETE', `/api/projects/${projectId}/watch`)).data).toEqual({ watching: false })
    })
  })

  describe('the feed', () => {
    it('lists recent public posts, two per author per page, with a cursor that pages without repeats', async () => {
      const author = await person('fd')
      const reader = await person('fd2')
      const ids: string[] = []
      for (let i = 0; i < 4; i++) ids.push((await post(author, { title: `Feed post ${i}` })).data.post.id)
      const page = await req(reader.jar, 'GET', '/api/feed?limit=50')
      expect(page.status).toBe(200)
      expect(page.data.tab).toBe('for-you')
      const mine = page.data.posts.filter((p: { author: { id: string } }) => p.author.id === author.userId)
      expect(mine.length).toBeLessThanOrEqual(2)

      // Walk the pages: every post at most once, and the author's four turn up across pages.
      const seen: string[] = []
      let cursor: string | null = null
      for (let guard = 0; guard < 10; guard++) {
        const res: Awaited<ReturnType<typeof req>> = await req(reader.jar, 'GET', `/api/feed?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        expect(res.status).toBe(200)
        for (const p of res.data.posts) seen.push(p.id)
        cursor = res.data.nextCursor
        if (!cursor) break
      }
      expect(new Set(seen).size).toBe(seen.length)
      for (const id of ids) expect(seen).toContain(id)
    })

    it('rejects a bad tab, limit and cursor', async () => {
      const a = await person('fb')
      expect((await req(a.jar, 'GET', '/api/feed?tab=everything')).status).toBe(400)
      expect((await req(a.jar, 'GET', '/api/feed?limit=0')).status).toBe(400)
      expect((await req(a.jar, 'GET', '/api/feed?limit=500')).status).toBe(400)
      expect((await req(a.jar, 'GET', '/api/feed?cursor=garbage')).data.error.code).toBe('INVALID_CURSOR')
    })

    it('has a following tab with only the people and projects you follow or watch', async () => {
      const followed = await person('ft')
      const other = await person('ft2')
      const me = await person('ft3')
      await req(me.jar, 'POST', `/api/users/${followed.userId}/follow`)
      const wanted = (await post(followed)).data.post.id
      const unwanted = (await post(other)).data.post.id
      const feed = await req(me.jar, 'GET', '/api/feed?tab=following')
      const ids = feed.data.posts.map((p: { id: string }) => p.id)
      expect(ids).toContain(wanted)
      expect(ids).not.toContain(unwanted)
    })

    it('has city and campus tabs that are empty until the viewer has a place, then show their neighbours', async () => {
      const here = await person('fc')
      const neighbour = await person('fc2')
      const far = await person('fc3')
      expect((await req(here.jar, 'GET', '/api/feed?tab=city')).data.posts).toEqual([])
      const key = `feedcity${suffix}`
      for (const [u, cityKey] of [[here, key], [neighbour, key], [far, `${key}x`]] as const) await testPrisma.profile.upsert({ where: { userId: u.userId }, create: { userId: u.userId, cityKey, city: cityKey }, update: { cityKey, city: cityKey } })
      const near = (await post(neighbour)).data.post.id
      const away = (await post(far)).data.post.id
      const ids = (await req(here.jar, 'GET', '/api/feed?tab=city')).data.posts.map((p: { id: string }) => p.id)
      expect(ids).toContain(near)
      expect(ids).not.toContain(away)
    })

    it('does not change the XP of anyone for reading it', async () => {
      const a = await person('fx')
      const before = (await testPrisma.user.findUniqueOrThrow({ where: { id: a.userId } })).xp
      await req(a.jar, 'GET', '/api/feed')
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: a.userId } })).xp).toBe(before)
    })
  })

  describe('timelines', () => {
    it('pages a person’s posts newest first by cursor', async () => {
      const a = await person('tl')
      const viewer = await person('tl2')
      const made: string[] = []
      for (let i = 0; i < 3; i++) made.push((await post(a, { title: `Timeline ${i}` })).data.post.id)
      const first = await req(viewer.jar, 'GET', `/api/users/${a.userId}/posts?limit=2`)
      expect(first.data.posts.map((p: { id: string }) => p.id)).toEqual([made[2], made[1]])
      expect(first.data.nextCursor).toBeTruthy()
      const second = await req(viewer.jar, 'GET', `/api/users/${a.userId}/posts?limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}`)
      expect(second.data.posts.map((p: { id: string }) => p.id)).toEqual([made[0]])
      expect(second.data.nextCursor).toBeNull()
      expect((await req(viewer.jar, 'GET', '/api/users/nope/posts')).data.error.code).toBe('USER_NOT_FOUND')
      expect((await req(viewer.jar, 'GET', `/api/users/${a.userId}/posts?cursor=zzz`)).data.error.code).toBe('INVALID_CURSOR')
      const own = await req(a.jar, 'GET', '/api/posts')
      expect(own.data.posts).toHaveLength(3)
    })
  })

  describe('Ship Day', () => {
    it('answers for the caller’s own Friday with their ships and the best posts', async () => {
      const a = await person('sd', { timezone: 'Pacific/Kiritimati' })
      const res = await req(a.jar, 'GET', '/api/ship-day')
      expect(res.status).toBe(200)
      expect(res.data).toEqual(expect.objectContaining({ isShipDay: expect.any(Boolean), startsAt: expect.any(String), endsAt: expect.any(String), dateKey: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), todayCount: expect.any(Number), yourShips: expect.any(Array), topPosts: expect.any(Array) }))
      expect(new Date(res.data.endsAt).getTime() - new Date(res.data.startsAt).getTime()).toBe(24 * 60 * 60_000)
    })

    it('tags a post made on the author’s Friday and counts it for the day', async () => {
      const a = await person('sf')
      const today = (await req(a.jar, 'GET', '/api/ship-day')).data
      // The suite runs on any weekday: on a Friday the real route is exercised, on any other day the same rule is exercised with a stored date.
      const { createPost } = await import('../../src/lib/posts/posts')
      const { shipDayFor } = await import('../../src/lib/ship-day')
      const friday = new Date(`${today.dateKey}T12:00:00Z`)
      expect(shipDayFor(friday, null).isShipDay).toBe(true)
      const result = await createPost(testPrisma, { id: a.userId, timezone: null }, { kind: 'DEMO', title: 'On a Friday', body: 'x', links: [], mediaIds: [], stackTags: [], coAuthorIds: [], visibility: 'PUBLIC' }, friday)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.post.shipDayKey).toBe(today.dateKey)
      expect(result.post.stackTags).toContain('ship-day')
      expect(await testPrisma.userCounter.findUnique({ where: { userId_key: { userId: a.userId, key: 'ship_day_posts' } } })).toMatchObject({ value: 1 })
    })

    it('writes the Saturday recap once, with the best posts and the places they came from', async () => {
      const { writeShipDayRecap } = await import('../../src/lib/posts/ship-day')
      const { createPost } = await import('../../src/lib/posts/posts')
      // A Friday far from any real one, so no other run's posts are in it.
      const friday = new Date('2031-05-09T12:00:00Z')
      const saturday = new Date('2031-05-10T13:00:00Z')
      const a = await person('rc')
      const b = await person('rc2')
      const cityKey = `recapcity${suffix}`
      for (const u of [a, b]) await testPrisma.profile.upsert({ where: { userId: u.userId }, create: { userId: u.userId, cityKey, city: cityKey, countryCode: 'ZZ' }, update: { cityKey, city: cityKey, countryCode: 'ZZ' } })
      const input = { kind: 'DEMO' as const, body: 'x', links: [], mediaIds: [], stackTags: [], coAuthorIds: [], visibility: 'PUBLIC' as const }
      const best = await createPost(testPrisma, { id: a.userId, timezone: null }, { ...input, title: 'Best of the day' }, friday)
      const other = await createPost(testPrisma, { id: b.userId, timezone: null }, { ...input, title: 'Also shipped' }, friday)
      if (!best.ok || !other.ok) throw new Error('could not seed posts')
      await testPrisma.shipPost.update({ where: { id: best.post.id }, data: { propsScore: 9 } })

      const first = await writeShipDayRecap(testPrisma, saturday)
      expect(first).toMatchObject({ dateKey: '2031-05-09', weekKey: '2031-W19', created: true })
      const row = await testPrisma.shipDayRecap.findUniqueOrThrow({ where: { weekKey: '2031-W19' } })
      expect(row.totalPosts).toBe(first.totalPosts)
      expect((row.topPosts as { postId: string }[])[0].postId).toBe(best.post.id)
      const places = row.places as { countries: { code: string; count: number }[]; cities: { key: string; count: number }[] }
      expect(places.cities).toContainEqual({ key: cityKey, count: 2 })
      expect(places.countries.find((c) => c.code === 'ZZ')?.count).toBeGreaterThanOrEqual(2)

      // Running it again changes nothing.
      const again = await writeShipDayRecap(testPrisma, saturday)
      expect(again).toMatchObject({ created: false, totalPosts: first.totalPosts })
      expect(await testPrisma.shipDayRecap.count({ where: { weekKey: '2031-W19' } })).toBe(1)
      await testPrisma.shipDayRecap.deleteMany({ where: { weekKey: '2031-W19' } })
      await testPrisma.shipPost.deleteMany({ where: { id: { in: [best.post.id, other.post.id] } } })
    })
  })
})
