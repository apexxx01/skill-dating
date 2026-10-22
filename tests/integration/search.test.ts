import { describe, it, expect, afterAll } from 'vitest'
import { cleanupTestUsers, testPrisma } from './db'
import { registerAndLogin, req, uniqueSuffix, type TestUser } from './helpers'
import { makePerson, removePeople } from './matching-fixtures'
import { makeRomancePerson } from './romance-fixtures'

// GET /api/search against the real server: what matches, how it ranks, and above all what it never returns. Every entity carries a word made for this run, so the searches
// are about these rows only (the database is shared with every other test file).
describe('universal search', () => {
  const suffix = uniqueSuffix()
  const tag = `sr${suffix}`
  // A word that exists only in the rows of one test: letters only, with random letters of its own. (A suffix shared by all the words would make them similar to each other,
  // and similar is exactly what a typo-tolerant search finds.)
  const word = (base: string) => `${base}${Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')}`
  const created = { skills: [] as string[], hackathons: [] as string[], projects: [] as string[], teams: [] as string[], posts: [] as string[], flags: [] as string[] }
  let viewerCounter = 0

  afterAll(async () => {
    await testPrisma.shipPost.deleteMany({ where: { id: { in: created.posts } } })
    await testPrisma.project.deleteMany({ where: { id: { in: created.projects } } })
    await testPrisma.team.deleteMany({ where: { id: { in: created.teams } } })
    await testPrisma.hackathon.deleteMany({ where: { id: { in: created.hackathons } } })
    await testPrisma.skill.deleteMany({ where: { id: { in: created.skills } } })
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 180_000)

  async function viewer(): Promise<TestUser> {
    const name = `srv${suffix}${viewerCounter++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  const search = (who: TestUser, q: string, extra = '') => req(who.jar, 'GET', `/api/search?q=${encodeURIComponent(q)}${extra}`)
  const idsOf = (res: { data: any }) => (res.data.results as { id: string }[]).map((hit) => hit.id)
  const person = (name: string, options: Parameters<typeof makePerson>[0] extends infer O ? Partial<O> : never = {}) => makePerson({ tag, profile: false, ...options }).then(async (p) => {
    await testPrisma.user.update({ where: { id: p.id }, data: { name } })
    return p
  })
  const project = async (ownerId: string, name: string, over: Record<string, unknown> = {}) => {
    const row = await testPrisma.project.create({ data: { ownerId, name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`, ...over } })
    created.projects.push(row.id)
    return row
  }
  const post = async (authorId: string, title: string, over: Record<string, unknown> = {}) => {
    const row = await testPrisma.shipPost.create({ data: { authorId, kind: 'SHIP', title, body: `${title} body`, ...over } })
    created.posts.push(row.id)
    return row
  }

  describe('matching', () => {
    it('puts an exact username first, then usernames that start with it, and finds people by the start of their name', async () => {
      const me = await viewer()
      const w = word('quasar')
      const exact = await person('Someone Else', { })
      await testPrisma.user.update({ where: { id: exact.id }, data: { username: w } })
      const prefixed = await makePerson({ tag: `${w}x`, profile: false })
      await testPrisma.user.update({ where: { id: prefixed.id }, data: { name: 'Plain Name' } })
      const byName = await person(`Zed ${w}son`)
      const res = await search(me, w)
      expect(res.status).toBe(200)
      expect(idsOf(res)[0]).toBe(exact.id)
      expect(idsOf(res)).toEqual(expect.arrayContaining([exact.id, prefixed.id]))
      // A word inside a name is a prefix match on that word.
      expect(idsOf(await search(me, `zed ${w.slice(0, 6)}`))).toContain(byName.id)
      expect(res.data.query).toBe(w)
    })

    it('tolerates typos in names, and ignores accents and case', async () => {
      const me = await viewer()
      const w = word('hopperton')
      const grace = await person(`Gráce ${w}`)
      expect(idsOf(await search(me, `grase ${w}`))).toContain(grace.id)
      expect(idsOf(await search(me, `GRACE ${w.toUpperCase()}`))).toContain(grace.id)
      const surname = word('belmonte')
      const jose = await person(`José Ñandú ${surname}`)
      expect(idsOf(await search(me, `jose nandu ${surname}`))).toContain(jose.id)
    })

    it('finds people by the skills they list', async () => {
      const me = await viewer()
      const w = word('zigzag')
      const skill = await testPrisma.skill.create({ data: { name: w, slug: `s-${w}`, category: 'Test' } })
      created.skills.push(skill.id)
      const coder = await person('Skillful Person')
      const other = await person('Skill Less')
      await testPrisma.userSkill.create({ data: { userId: coder.id, skillId: skill.id } })
      const ids = idsOf(await search(me, w, '&types=users'))
      expect(ids).toContain(coder.id)
      expect(ids).not.toContain(other.id)
    })

    it('finds each kind of thing by the words in it, and narrows to the types asked for', async () => {
      const me = await viewer()
      const owner = await person('Owner Person')
      const w = word('kelvin')
      const p = await project(owner.id, `${w} compiler`, { shortDesc: 'Tiny', techStack: ['rust'] })
      const team = await testPrisma.team.create({ data: { name: `${w} crew`, slug: `crew-${w}`, ownerId: owner.id, description: 'A crew' } })
      created.teams.push(team.id)
      const hack = await testPrisma.hackathon.create({ data: { name: `${w} hackathon`, slug: `h-${w}`, description: 'x', startDate: new Date(Date.now() + 86_400_000), endDate: new Date(Date.now() + 2 * 86_400_000) } })
      created.hackathons.push(hack.id)
      const ship = await post(owner.id, `Shipped ${w} today`)

      const all = await search(me, w)
      const byType = Object.fromEntries((all.data.results as any[]).map((hit) => [hit.type, hit]))
      expect(byType.project).toMatchObject({ id: p.id, name: `${w} compiler`, summary: 'Tiny', isPublic: true })
      expect(byType.crew).toMatchObject({ id: team.id, name: `${w} crew`, memberCount: 0 })
      expect(byType.hackathon).toMatchObject({ id: hack.id, verified: true, status: 'UPCOMING' })
      expect(byType.post).toMatchObject({ id: ship.id, kind: 'SHIP', author: { id: owner.id, username: owner.username } })

      expect((await search(me, w, '&types=projects,crews')).data.results.map((hit: any) => hit.type).sort()).toEqual(['crew', 'project'])
      expect((await search(me, w, '&types=hackathons')).data.results).toHaveLength(1)
      expect(idsOf(await search(me, `${w.slice(0, 5)} comp`, '&types=projects'))).toContain(p.id)
    })

    it('returns only the public fields of a person', async () => {
      const me = await viewer()
      const w = word('onlypublic')
      const someone = await person(`Pub ${w}`)
      await testPrisma.user.update({ where: { id: someone.id }, data: { headline: 'Builds things', bio: 'secret bio', location: 'Hidden city', website: 'https://example.com' } })
      const [hit] = (await search(me, w, '&types=users')).data.results
      expect(Object.keys(hit).sort()).toEqual(['headline', 'id', 'image', 'name', 'type', 'username'])
      expect(JSON.stringify(hit)).not.toMatch(/secret bio|Hidden city|example\.com|@test\.dev/)
    })
  })

  describe('what it never returns', () => {
    it('hides people the caller blocked or muted, who blocked the caller, and what those people made', async () => {
      const me = await viewer()
      const w = word('shunned')
      const blocked = await person(`${w} one`)
      const blocker = await person(`${w} two`)
      const muted = await person(`${w} three`)
      const visible = await person(`${w} four`)
      for (const p of [blocked, blocker, muted, visible]) {
        await project(p.id, `${w} project of ${p.username}`)
        await post(p.id, `${w} post of ${p.username}`)
      }
      await testPrisma.block.create({ data: { blockerId: me.userId, blockedId: blocked.id } })
      await testPrisma.block.create({ data: { blockerId: blocker.id, blockedId: me.userId } })
      await testPrisma.mute.create({ data: { muterId: me.userId, mutedId: muted.id } })
      const res = await search(me, w, '&limit=25')
      const people = (res.data.results as any[]).filter((hit) => hit.type === 'user').map((hit) => hit.id)
      expect(people).toEqual([visible.id])
      const authors = (res.data.results as any[]).filter((hit) => hit.type === 'post').map((hit) => hit.author.id)
      expect(authors).toEqual([visible.id])
      expect((res.data.results as any[]).filter((hit) => hit.type === 'project')).toHaveLength(1)
    })

    it('hides deleted, suspended, banned and age-closed accounts, invisible mode, and a high risk account unless found by its exact username', async () => {
      const me = await viewer()
      const w = word('absent')
      const deleted = await person(`${w} deleted`, { deleted: true })
      const suspended = await person(`${w} suspended`)
      const banned = await person(`${w} banned`)
      const closed = await person(`${w} closed`)
      const invisible = await person(`${w} invisible`)
      const risky = await person(`${w} risky`)
      const fine = await person(`${w} fine`)
      await testPrisma.userRestriction.create({ data: { userId: suspended.id, kind: 'SUSPENDED', endsAt: new Date(Date.now() + 86_400_000) } })
      await testPrisma.userRestriction.create({ data: { userId: banned.id, kind: 'BANNED' } })
      await testPrisma.user.update({ where: { id: closed.id }, data: { birthDateRefusedAt: new Date() } })
      await testPrisma.profile.create({ data: { userId: invisible.id, invisibleMode: true } })
      await testPrisma.userRisk.create({ data: { userId: risky.id, score: 90, level: 'HIGH' } })
      const ids = idsOf(await search(me, w, '&types=users&limit=25'))
      expect(ids).toEqual([fine.id])
      // Found by the exact username, a high risk account is there; the others stay out.
      expect(idsOf(await search(me, risky.username, '&types=users'))).toContain(risky.id)
      expect(idsOf(await search(me, deleted.username, '&types=users'))).not.toContain(deleted.id)
      expect(idsOf(await search(me, banned.username, '&types=users'))).not.toContain(banned.id)
      // The lifted restriction brings a person back.
      await testPrisma.userRestriction.updateMany({ where: { userId: suspended.id }, data: { liftedAt: new Date() } })
      expect(idsOf(await search(me, w, '&types=users&limit=25'))).toContain(suspended.id)
    })

    it('does not search a passport field that is not public, and does not return it', async () => {
      const me = await viewer()
      const secret = word('quokka')
      const hidden = await person(`Hidden ${word('hiddenname')}`)
      const open = await person(`Open ${word('openname')}`)
      await testPrisma.user.update({ where: { id: hidden.id }, data: { headline: `${secret} wrangler`, builderRole: `${secret}er` } })
      await testPrisma.user.update({ where: { id: open.id }, data: { headline: `${secret} wrangler` } })
      await testPrisma.profile.create({ data: { userId: hidden.id, fieldVisibility: { headline: 'PRIVATE', builderRole: 'CONNECTIONS' } } })
      const found = await search(me, secret, '&types=users')
      expect(idsOf(found)).toEqual([open.id])
      expect(found.data.results[0].headline).toBe(`${secret} wrangler`)
      // Found by name, the private headline is not shown.
      const byName = (await search(me, hidden.username, '&types=users')).data.results[0]
      expect(byName.id).toBe(hidden.id)
      expect(byName.headline).toBeNull()
      expect(JSON.stringify(byName)).not.toContain(secret)
    })

    it('shows a post to the people it is for: public to everyone, followers-only to followers, crew-only to the crew, always to its author', async () => {
      const me = await viewer()
      const stranger = await viewer()
      const author = await person('Post Author')
      const w = word('visibility')
      const pub = await post(author.id, `${w} public`)
      const followers = await post(author.id, `${w} followers`, { visibility: 'FOLLOWERS' })
      const crewProject = await project(author.id, `${w} crew project`, { isPublic: false })
      const crew = await post(author.id, `${w} crew`, { visibility: 'CREW', projectId: crewProject.id })
      const hiddenByMod = await post(author.id, `${w} moderated`, { moderatedAt: new Date(), deletedAt: new Date() })
      const removed = await post(author.id, `${w} removed`, { deletedAt: new Date() })
      await testPrisma.follow.create({ data: { followerId: me.userId, followeeId: author.id } })
      await testPrisma.projectMember.create({ data: { projectId: crewProject.id, userId: stranger.userId } })

      const seenBy = async (who: TestUser) => idsOf(await search(who, w, '&types=posts&limit=25')).sort()
      expect(await seenBy(me)).toEqual([pub.id, followers.id].sort())
      expect(await seenBy(stranger)).toEqual([pub.id, crew.id].sort())
      const outsider = await viewer()
      expect(await seenBy(outsider)).toEqual([pub.id])
      for (const gone of [hiddenByMod.id, removed.id]) for (const who of [me, stranger, outsider]) expect(await seenBy(who)).not.toContain(gone)
    })

    it('finds a private project only for its owner and members', async () => {
      const owner = await viewer()
      const member = await viewer()
      const outsider = await viewer()
      const w = word('private')
      const row = await project(owner.userId, `${w} lab`, { isPublic: false })
      await testPrisma.projectMember.create({ data: { projectId: row.id, userId: member.userId } })
      expect(idsOf(await search(owner, w, '&types=projects'))).toEqual([row.id])
      expect(idsOf(await search(member, w, '&types=projects'))).toEqual([row.id])
      expect(idsOf(await search(outsider, w, '&types=projects'))).toEqual([])
    })

    it('hides a hackathon that is not public or that a moderator hid', async () => {
      const me = await viewer()
      const w = word('hackhidden')
      const make = async (name: string, over: Record<string, unknown>) => {
        const row = await testPrisma.hackathon.create({ data: { name, slug: `${name.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`, description: 'x', startDate: new Date(), endDate: new Date(Date.now() + 86_400_000), ...over } })
        created.hackathons.push(row.id)
        return row
      }
      const open = await make(`${w} open`, {})
      await make(`${w} private`, { isPublic: false })
      await make(`${w} moderated`, { moderatedAt: new Date() })
      const unverified = await make(`${w} external`, { source: 'EXTERNAL', externalUrl: `https://example.com/${w}`, platform: 'OTHER' })
      const res = await search(me, w, '&types=hackathons')
      expect(idsOf(res).sort()).toEqual([open.id, unverified.id].sort())
      expect((res.data.results as any[]).find((hit) => hit.id === unverified.id).verified).toBe(false)
    })

    it('knows nothing of the romance mode: not its answers, not that a person is in it', async () => {
      const me = await viewer()
      const w = word('romantic')
      const inMode = await makeRomancePerson({ tag, gender: 'WOMAN', interestedIn: ['MAN'], obsessions: [w], direction: w, rhythm: w })
      await testPrisma.user.update({ where: { id: inMode.id }, data: { name: 'Plain Passport' } })
      await testPrisma.romanceProfile.updateMany({ where: { userId: inMode.id }, data: { promptObsessed: `${w} obsessed`, promptBuild: `${w} build`, promptWeekend: `${w} weekend` } })
      for (const q of [w, 'obsessed', 'interested in man', 'woman']) {
        const res = await search(me, q)
        expect(idsOf(res), q).not.toContain(inMode.id)
      }
      // Found as anyone is, by the ordinary passport, and the hit says nothing about the mode.
      const hit = (await search(me, inMode.username, '&types=users')).data.results.find((h: any) => h.id === inMode.id)
      expect(hit).toBeDefined()
      expect(JSON.stringify(hit)).not.toMatch(/romance|dating|WOMAN|gender|interested/i)
    })
  })

  describe('paging and limits', () => {
    it('pages through everything once, in a stable order, across types', async () => {
      const me = await viewer()
      const w = word('pagination')
      const owner = await person(`Pager ${w}`)
      const others = await Promise.all([1, 2, 3].map((n) => person(`${w} person ${n}`)))
      for (let i = 0; i < 3; i++) await project(owner.id, `${w} project ${i}`)
      for (let i = 0; i < 3; i++) await post(owner.id, `${w} post ${i}`)
      const everything = await search(me, w, '&limit=25')
      const total = everything.data.results.length
      expect(total).toBeGreaterThanOrEqual(10)
      expect(everything.data.nextCursor).toBeNull()

      const seen: string[] = []
      const trace: unknown[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const res: { status: number; data: any } = await search(me, w, `&limit=3${cursor ? `&cursor=${cursor}` : ''}`)
        expect(res.status).toBe(200)
        trace.push({ ids: res.data.results.map((hit: any) => `${hit.type}:${hit.id.slice(-5)}`), next: res.data.nextCursor ? JSON.parse(Buffer.from(res.data.nextCursor, 'base64url').toString()) : null })
        seen.push(...idsOf(res))
        cursor = res.data.nextCursor
        pages += 1
      } while (cursor && pages < 20)
      expect(seen, JSON.stringify({ trace, all: everything.data.results.map((hit: any) => `${hit.type}:${hit.id.slice(-5)}`) })).toEqual(idsOf(everything))
      expect(new Set(seen).size).toBe(seen.length)
      expect(pages).toBe(Math.ceil(total / 3))
      expect(others.length).toBe(3)
    })

    it('answers an empty list for a query too short to search, and refuses bad input', async () => {
      const me = await viewer()
      for (const q of ['', 'a', '!!', ' ']) expect((await search(me, q)).data).toEqual({ query: q.replace(/\W/g, ''), types: ['users', 'projects', 'crews', 'hackathons', 'posts'], results: [], nextCursor: null })
      expect((await search(me, 'abc', '&types=users,romance')).data.error.code).toBe('VALIDATION_FAILED')
      expect((await search(me, 'abc', '&limit=26')).data.error.code).toBe('VALIDATION_FAILED')
      expect((await search(me, 'abc', '&limit=0')).data.error.code).toBe('VALIDATION_FAILED')
      expect((await search(me, 'abc', '&cursor=junk')).data.error.code).toBe('INVALID_CURSOR')
    })

    it('survives hostile input: SQL, tsquery syntax, very long and odd text', async () => {
      const me = await viewer()
      for (const q of [`'; DROP TABLE "User"; --`, 'a:* | b & !c', '((((', 'x'.repeat(190), '\u0000null', '%_%_%', '"quoted phrase"', '😀😀😀']) {
        const res = await search(me, q)
        expect(res.status, q).toBe(200)
      }
      expect(await testPrisma.user.count()).toBeGreaterThan(0)
    })

    it('needs a signed-in caller', async () => {
      expect((await req(null, 'GET', '/api/search?q=anything')).status).toBe(401)
    })
  })
})
