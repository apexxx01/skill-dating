import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers, testPrisma } from './db'
import { syntheticIp, uniqueSuffix } from './helpers'
import { bornYearsAgo, makePerson, removePeople } from './matching-fixtures'
import { achievementCard, passportCard, postCard, squadCard } from '../../src/lib/og/data'

// The share cards (GET /api/og/...): public images, so the interesting part is who and what is left out. The rules are checked on the data a card is drawn from (the
// image is drawn from nothing else), and the routes are checked for what they answer: the picture, the cache headers, the ETag, and the same 404 for everything that may not be shown.
describe('share cards', () => {
  const suffix = uniqueSuffix()
  const tag = `og${suffix}`
  const created = { hackathons: [] as string[], teams: [] as string[], posts: [] as string[], achievements: [] as string[], projects: [] as string[] }
  const ADULT = bornYearsAgo(30, 100)

  beforeAll(() => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await testPrisma.shipPost.deleteMany({ where: { id: { in: created.posts } } })
    await testPrisma.project.deleteMany({ where: { id: { in: created.projects } } })
    await testPrisma.team.deleteMany({ where: { id: { in: created.teams } } })
    await testPrisma.hackathon.deleteMany({ where: { id: { in: created.hackathons } } })
    await testPrisma.achievement.deleteMany({ where: { id: { in: created.achievements } } })
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 120_000)

  let counter = 0
  async function person(over: { name?: string | null; headline?: string | null; role?: string | null; birthDate?: string | null; xp?: number; deleted?: boolean } = {}) {
    const made = await makePerson({ tag, profile: false, birthDate: over.birthDate === undefined ? ADULT : over.birthDate, deleted: over.deleted, xp: over.xp })
    await testPrisma.user.update({ where: { id: made.id }, data: { name: over.name === undefined ? `Person ${counter++}` : over.name, headline: over.headline ?? null, builderRole: over.role ?? null } })
    return made
  }
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${INTEGRATION_BASE_URL}${path}`, { headers: { 'x-forwarded-for': syntheticIp(), ...headers }, redirect: 'manual' })
  const isPng = async (res: Response) => {
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.length > 1000 && [0x89, 0x50, 0x4e, 0x47].every((byte, i) => bytes[i] === byte)
  }
  /** The versioned address of a card from GET /api/og/link: the body of the answer. */
  const link = async (params: Record<string, string>) => {
    const res = await get(`/api/og/link?${new URLSearchParams(params)}`)
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() }
  }
  const makePost = async (authorId: string, over: Record<string, unknown> = {}) => {
    const row = await testPrisma.shipPost.create({ data: { authorId, kind: 'SHIP', title: 'My first ship', body: 'It **works**. See [the repo](https://example.com).', ...over } })
    created.posts.push(row.id)
    return row
  }

  describe('the passport card', () => {
    it('is a PNG with a day of caching and an ETag, and a request that already has it gets a 304 and no picture', async () => {
      const a = await person({ name: 'Ada Lovelace', headline: 'Builds engines', role: 'Mathematician', xp: 1200 })
      const res = await get(`/api/og/passport/${a.username}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400, stale-while-revalidate=604800')
      const etag = res.headers.get('etag')!
      expect(etag).toMatch(/^"og-[0-9a-f]{24}"$/)
      expect(await isPng(res)).toBe(true)

      const again = await get(`/api/og/passport/${a.username}`, { 'if-none-match': etag })
      expect(again.status).toBe(304)
      expect(await again.text()).toBe('')
      expect(again.headers.get('etag')).toBe(etag)

      // The tag follows what is drawn: more XP, a new level, a new picture.
      await testPrisma.user.update({ where: { id: a.id }, data: { xp: 900_000 } })
      const changed = await get(`/api/og/passport/${a.username}`, { 'if-none-match': etag })
      expect(changed.status).toBe(200)
      expect(changed.headers.get('etag')).not.toBe(etag)
      await changed.arrayBuffer()
    })

    it('has a versioned address that changes when the person does, keeps the long cache, and is empty when there is no card', async () => {
      const a = await person({ name: 'Ada Lovelace', headline: 'Builds engines' })
      const first = await link({ kind: 'passport', id: a.username })
      expect(first).toMatchObject({ status: 200, cache: 'no-store' })
      expect(first.data.path).toMatch(new RegExp(`^/api/og/passport/${a.username}\\?v=[0-9a-f]{12}$`))
      expect(first.data.url).toBe(`${INTEGRATION_BASE_URL}${first.data.path}`)
      // The same until something changes.
      expect((await link({ kind: 'passport', id: a.username.toUpperCase() })).data.path.split('?')[1]).toBe(first.data.path.split('?')[1])
      // The address serves the card, with the day-long cache.
      const card = await get(first.data.path)
      expect(card.status).toBe(200)
      expect(card.headers.get('cache-control')).toBe('public, max-age=86400, stale-while-revalidate=604800')
      await card.arrayBuffer()

      // An edit gives a new address; the old one still answers, with the current picture.
      await testPrisma.user.update({ where: { id: a.id }, data: { headline: 'Builds better engines' } })
      const second = await link({ kind: 'passport', id: a.username })
      expect(second.data.path).not.toBe(first.data.path)
      const old = await get(first.data.path)
      expect(old.status).toBe(200)
      await old.arrayBuffer()
      // So does changing what the person shares, and earning something.
      await testPrisma.profile.upsert({ where: { userId: a.id }, create: { userId: a.id, fieldVisibility: { headline: 'PRIVATE' } }, update: { fieldVisibility: { headline: 'PRIVATE' } } })
      const third = await link({ kind: 'passport', id: a.username })
      expect(third.data.path).not.toBe(second.data.path)

      // No card, no address: for a person who turned cards off, a minor, and a name that is nobody's; the same answer for each.
      await testPrisma.profile.update({ where: { userId: a.id }, data: { showCardsOnWeb: false } })
      const kid = await person({ birthDate: bornYearsAgo(16, 40) })
      for (const username of [a.username, kid.username, `nobody-${tag}`]) expect((await link({ kind: 'passport', id: username })).data, username).toEqual({ path: null, url: null })
    })

    it('refuses a bad request to the address route, and an achievement address without a person', async () => {
      expect((await link({ kind: 'nope', id: 'x' })).status).toBe(400)
      expect((await link({ kind: 'passport' })).status).toBe(400)
      expect((await link({ kind: 'passport', id: 'x'.repeat(101) })).status).toBe(400)
      expect((await link({ kind: 'achievement', id: 'whatever' })).data).toEqual({ path: null, url: null })
    })

    it('finds the person whatever the case of the username', async () => {
      const a = await person()
      const res = await get(`/api/og/passport/${a.username.toUpperCase()}`)
      expect(res.status).toBe(200)
      await res.arrayBuffer()
    })

    it('draws a name with Latin Extended letters, and falls back to the username for one it has no letters for', async () => {
      const latin = await person({ name: 'Łukasz Żółć' })
      const other = await person({ name: 'Привет 😀' })
      const res = await get(`/api/og/passport/${latin.username}`)
      expect(await isPng(res)).toBe(true)
      expect((await passportCard(testPrisma, latin.username))!.name).toBe('Łukasz Żółć')
      expect((await passportCard(testPrisma, other.username))!.name).toBeNull()
      const fallback = await get(`/api/og/passport/${other.username}`)
      expect(await isPng(fallback)).toBe(true)
    })

    it('has no card for a minor (16 or 17), or for a person with no date of birth yet, whatever their settings say', async () => {
      for (const birthDate of [bornYearsAgo(16, 40), bornYearsAgo(17, 100), null]) {
        const kid = await person({ name: 'Young Person', headline: 'Learning', role: 'Student', birthDate })
        expect(await passportCard(testPrisma, kid.username)).toBeNull()
        // Even a stored "on" (which the switch itself refuses for them) draws nothing.
        await testPrisma.profile.upsert({ where: { userId: kid.id }, create: { userId: kid.id, showCardsOnWeb: true }, update: { showCardsOnWeb: true } })
        expect(await passportCard(testPrisma, kid.username)).toBeNull()
        const res = await get(`/api/og/passport/${kid.username}`)
        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe('CARD_NOT_FOUND')
      }
    })

    it('has no card for an adult who turned "show my cards on the web" off, and has one again when they turn it back on', async () => {
      const a = await person({ name: 'Private Adult' })
      expect((await get(`/api/og/passport/${a.username}`)).status).toBe(200)
      await testPrisma.profile.upsert({ where: { userId: a.id }, create: { userId: a.id, showCardsOnWeb: false }, update: { showCardsOnWeb: false } })
      const res = await get(`/api/og/passport/${a.username}`)
      expect(res.status).toBe(404)
      expect((await res.json()).error.code).toBe('CARD_NOT_FOUND')
      expect(await passportCard(testPrisma, a.username)).toBeNull()
      await testPrisma.profile.update({ where: { userId: a.id }, data: { showCardsOnWeb: true } })
      expect((await get(`/api/og/passport/${a.username}`)).status).toBe(200)
    })

    it('shows an adult’s name, headline, role and top skills, but only the fields they left public', async () => {
      const skill = await testPrisma.skill.upsert({ where: { slug: `og2-${tag}` }, update: {}, create: { name: `Rust ${tag}`, slug: `og2-${tag}`, category: 'Test' } })
      const a = await person({ name: 'Grace Hopper', headline: 'Compilers', role: 'Admiral' })
      await testPrisma.userSkill.create({ data: { userId: a.id, skillId: skill.id, level: 5 } })
      expect(await passportCard(testPrisma, a.username)).toMatchObject({ name: 'Grace Hopper', headline: 'Compilers', role: 'Admiral', skills: [`Rust ${tag}`], level: 1, tier: 'BRONZE' })
      await testPrisma.profile.create({ data: { userId: a.id, fieldVisibility: { headline: 'CONNECTIONS', builderRole: 'PRIVATE' } } })
      const card = (await passportCard(testPrisma, a.username))!
      expect(card).toMatchObject({ name: 'Grace Hopper', headline: null, role: null })
      expect(JSON.stringify(card)).not.toMatch(/Compilers|Admiral|@test\.dev/)
      await testPrisma.userSkill.deleteMany({ where: { skillId: skill.id } })
      await testPrisma.skill.delete({ where: { id: skill.id } })
    })

    it('counts shipped public projects and achievements, and nothing private', async () => {
      const a = await person()
      const mk = async (status: 'SHIPPED' | 'BUILDING', isPublic: boolean) => {
        const row = await testPrisma.project.create({ data: { name: `P ${Math.random()}`, slug: `p-${Math.random().toString(36).slice(2)}`, ownerId: a.id, status, isPublic } })
        created.projects.push(row.id)
      }
      await mk('SHIPPED', true)
      await mk('SHIPPED', false)
      await mk('BUILDING', true)
      expect((await passportCard(testPrisma, a.username))!.projectsShipped).toBe(1)
    })

    it('has no card for an account that is deleted, closed for its age, suspended, banned, in invisible mode, or at a high risk level: the same 404 as for one that never existed', async () => {
      const gone = await person({ deleted: true })
      const closed = await person()
      const suspended = await person()
      const banned = await person()
      const invisible = await person()
      const risky = await person()
      await testPrisma.user.update({ where: { id: closed.id }, data: { birthDateRefusedAt: new Date() } })
      await testPrisma.userRestriction.create({ data: { userId: suspended.id, kind: 'SUSPENDED', endsAt: new Date(Date.now() + 86_400_000) } })
      await testPrisma.userRestriction.create({ data: { userId: banned.id, kind: 'BANNED' } })
      await testPrisma.profile.create({ data: { userId: invisible.id, invisibleMode: true } })
      await testPrisma.userRisk.create({ data: { userId: risky.id, score: 95, level: 'HIGH' } })
      const never = await get('/api/og/passport/no-such-person-here')
      const neverBody = await never.json()
      expect(never.status).toBe(404)
      expect(neverBody.error.code).toBe('CARD_NOT_FOUND')
      for (const who of [gone, closed, suspended, banned, invisible, risky]) {
        const res = await get(`/api/og/passport/${who.username}`)
        expect(res.status, who.username).toBe(404)
        expect(res.headers.get('cache-control')).toBe('public, max-age=60')
        expect(await res.json()).toEqual(neverBody)
      }
    })
  })

  describe('the post card', () => {
    it('draws a public post, with the Markdown reduced to words and the author named', async () => {
      const a = await person({ name: 'Ada Lovelace' })
      const row = await makePost(a.id, { propsCount: 5, commentCount: 2 })
      const res = await get(`/api/og/post/${row.id}`)
      expect(res.status).toBe(200)
      expect(await isPng(res)).toBe(true)
      expect(await postCard(testPrisma, row.id)).toMatchObject({ title: 'My first ship', excerpt: 'It works. See the repo.', author: `Ada Lovelace (@${a.username})`, propsCount: 5, commentCount: 2, postKind: 'SHIP' })
    })

    it('has a versioned address for a public post that changes when it is edited, and none for one that has no card', async () => {
      const a = await person({ name: 'Ada Lovelace' })
      const row = await makePost(a.id)
      const first = await link({ kind: 'post', id: row.id })
      expect(first.data.path).toMatch(new RegExp(`^/api/og/post/${row.id}\\?v=[0-9a-f]{12}$`))
      expect((await get(first.data.path)).status).toBe(200)
      await testPrisma.shipPost.update({ where: { id: row.id }, data: { title: 'My second ship', editedAt: new Date(), revision: { increment: 1 } } })
      expect((await link({ kind: 'post', id: row.id })).data.path).not.toBe(first.data.path)
      const crew = await makePost(a.id, { visibility: 'CREW' })
      for (const id of [crew.id, 'not-a-post']) expect((await link({ kind: 'post', id })).data, id).toEqual({ path: null, url: null })
    })

    it('has no card for a post whose author turned their cards off', async () => {
      const a = await person({ name: 'Private Author' })
      const row = await makePost(a.id)
      expect((await get(`/api/og/post/${row.id}`)).status).toBe(200)
      await testPrisma.profile.upsert({ where: { userId: a.id }, create: { userId: a.id, showCardsOnWeb: false }, update: { showCardsOnWeb: false } })
      expect(await postCard(testPrisma, row.id)).toBeNull()
      expect((await get(`/api/og/post/${row.id}`)).status).toBe(404)
    })

    it('has no card for a post whose author is a minor', async () => {
      const kid = await person({ name: 'Young Person', birthDate: bornYearsAgo(16, 40) })
      const row = await makePost(kid.id)
      expect(await postCard(testPrisma, row.id)).toBeNull()
      expect((await get(`/api/og/post/${row.id}`)).status).toBe(404)
    })

    it('has no card for a post that is not public, or was hidden, removed or deleted, or whose author may not be shown', async () => {
      const a = await person()
      const followers = await makePost(a.id, { visibility: 'FOLLOWERS' })
      const crew = await makePost(a.id, { visibility: 'CREW' })
      const hidden = await makePost(a.id, { moderatedAt: new Date(), deletedAt: new Date() })
      const deleted = await makePost(a.id, { deletedAt: new Date() })
      const banned = await person()
      await testPrisma.userRestriction.create({ data: { userId: banned.id, kind: 'BANNED' } })
      const bannedPost = await makePost(banned.id)
      for (const row of [followers, crew, hidden, deleted, bannedPost]) {
        const res = await get(`/api/og/post/${row.id}`)
        expect(res.status, row.id).toBe(404)
        expect((await res.json()).error.code).toBe('CARD_NOT_FOUND')
      }
      expect((await get('/api/og/post/not-a-post')).status).toBe(404)
    })
  })

  describe('the squad card', () => {
    async function squad(over: { hackathon?: Record<string, unknown> } = {}) {
      const owner = await person({ name: 'Squad Owner' })
      const adult = await person({ name: 'Adult Member' })
      const kid = await person({ name: 'Young Member', birthDate: bornYearsAgo(16, 40) })
      const invisible = await person({ name: 'Hidden Member' })
      await testPrisma.profile.create({ data: { userId: invisible.id, invisibleMode: true } })
      const cardsOff = await person({ name: 'Private Member' })
      await testPrisma.profile.create({ data: { userId: cardsOff.id, showCardsOnWeb: false } })
      const hackathon = await testPrisma.hackathon.create({
        data: { name: `Hack ${tag}`, slug: `hack-${tag}-${Math.random().toString(36).slice(2, 7)}`, description: 'x', startDate: new Date(Date.now() - 3 * 86_400_000), endDate: new Date(Date.now() - 86_400_000), status: 'ENDED', ...over.hackathon },
      })
      created.hackathons.push(hackathon.id)
      const project = await testPrisma.project.create({ data: { name: `Built ${tag}`, slug: `built-${Math.random().toString(36).slice(2)}`, ownerId: owner.id } })
      created.projects.push(project.id)
      const team = await testPrisma.team.create({ data: { name: `Team ${tag}`, slug: `team-${Math.random().toString(36).slice(2)}`, ownerId: owner.id, hackathonId: hackathon.id, projectId: project.id } })
      created.teams.push(team.id)
      for (const m of [owner, adult, kid, invisible, cardsOff]) await testPrisma.teamMember.create({ data: { teamId: team.id, userId: m.id, role: m.id === owner.id ? 'OWNER' : 'MEMBER' } })
      await testPrisma.hackathonTeam.create({ data: { hackathonId: hackathon.id, teamId: team.id, name: `Squad ${tag}`, rank: 3 } })
      return { team, owner, adult, kid, invisible, cardsOff, hackathon }
    }

    it('recaps a squad after its hackathon, naming adults who can be found and only counting the rest', async () => {
      const { team, owner, adult, kid, invisible, cardsOff } = await squad()
      const res = await get(`/api/og/squad/${team.id}`)
      expect(res.status).toBe(200)
      expect(await isPng(res)).toBe(true)
      const card = (await squadCard(testPrisma, team.id))!
      expect(card).toMatchObject({ squad: `Squad ${tag}`, hackathon: `Hack ${tag}`, rank: 3, project: `Built ${tag}`, memberCount: 5, unnamed: 3 })
      expect(card.members.sort()).toEqual([`@${owner.username}`, `@${adult.username}`].sort())
      expect(JSON.stringify(card)).not.toContain(kid.username)
      expect(JSON.stringify(card)).not.toContain(invisible.username)
      expect(JSON.stringify(card)).not.toContain(cardsOff.username)
      expect(JSON.stringify(card)).not.toMatch(/Young Member|Hidden Member|Private Member/)
    })

    it('has a versioned address for a recap that changes when the squad, its hackathon or its members change', async () => {
      const { team, owner, hackathon } = await squad()
      const first = await link({ kind: 'squad', id: team.id })
      expect(first.data.path).toMatch(new RegExp(`^/api/og/squad/${team.id}\\?v=[0-9a-f]{12}$`))
      expect((await get(first.data.path)).status).toBe(200)
      await testPrisma.hackathon.update({ where: { id: hackathon.id }, data: { name: `Renamed ${tag}` } })
      const second = await link({ kind: 'squad', id: team.id })
      expect(second.data.path).not.toBe(first.data.path)
      await testPrisma.user.update({ where: { id: owner.id }, data: { name: 'Squad Owner Renamed' } })
      expect((await link({ kind: 'squad', id: team.id })).data.path).not.toBe(second.data.path)
      const early = await squad({ hackathon: { status: 'ACTIVE' } })
      expect((await link({ kind: 'squad', id: early.team.id })).data).toEqual({ path: null, url: null })
    })

    it('has no recap before the hackathon is over, or for one that is not public or was hidden', async () => {
      for (const over of [{ status: 'ACTIVE' }, { isPublic: false }, { moderatedAt: new Date() }]) {
        const { team } = await squad({ hackathon: over })
        const res = await get(`/api/og/squad/${team.id}`)
        expect(res.status, JSON.stringify(over)).toBe(404)
      }
      expect((await get('/api/og/squad/not-a-squad')).status).toBe(404)
    })
  })

  describe('the achievement card', () => {
    async function achievement() {
      const row = await testPrisma.achievement.create({ data: { name: `First ship ${tag}`, slug: `first-ship-${tag}-${Math.random().toString(36).slice(2, 7)}`, description: 'Shipped a project', category: 'SHIPPING', xpReward: 100, criteria: {}, rarity: 0.125 } })
      created.achievements.push(row.id)
      return row
    }

    it('draws an achievement a person earned, with how rare it is', async () => {
      const a = await person({ name: 'Ada Lovelace' })
      const ach = await achievement()
      await testPrisma.userAchievement.create({ data: { userId: a.id, achievementId: ach.id, earnedAt: new Date('2026-10-20T10:00:00Z') } })
      const res = await get(`/api/og/achievement/${ach.slug}?user=${a.username}`)
      expect(res.status).toBe(200)
      expect(await isPng(res)).toBe(true)
      expect(await achievementCard(testPrisma, ach.slug, a.username)).toEqual({
        kind: 'achievement',
        name: `First ship ${tag}`,
        description: 'Shipped a project',
        xp: 100,
        rarityPercent: 12.5,
        earnedOn: '2026-10-20',
        holder: `Ada Lovelace (@${a.username})`,
      })
    })

    it('has a versioned address for an achievement that changes with the achievement or the person, and none for one not earned', async () => {
      const a = await person({ name: 'Ada Lovelace' })
      const b = await person()
      const ach = await achievement()
      await testPrisma.userAchievement.create({ data: { userId: a.id, achievementId: ach.id } })
      const first = await link({ kind: 'achievement', id: ach.slug, user: a.username })
      expect(first.data.path).toMatch(new RegExp(`^/api/og/achievement/${ach.slug}\\?user=${a.username}&v=[0-9a-f]{12}$`))
      expect((await get(first.data.path)).status).toBe(200)
      await testPrisma.achievement.update({ where: { id: ach.id }, data: { description: 'Shipped a project, twice' } })
      expect((await link({ kind: 'achievement', id: ach.slug, user: a.username })).data.path).not.toBe(first.data.path)
      for (const user of [b.username, 'nobody']) expect((await link({ kind: 'achievement', id: ach.slug, user })).data, user).toEqual({ path: null, url: null })
    })

    it('has no card for one the person has not earned, an unknown one, no user, or a person who may not be shown', async () => {
      const a = await person()
      const b = await person()
      const banned = await person()
      await testPrisma.userRestriction.create({ data: { userId: banned.id, kind: 'BANNED' } })
      const ach = await achievement()
      await testPrisma.userAchievement.create({ data: { userId: a.id, achievementId: ach.id } })
      await testPrisma.userAchievement.create({ data: { userId: banned.id, achievementId: ach.id } })
      for (const path of [`/api/og/achievement/${ach.slug}?user=${b.username}`, `/api/og/achievement/nope?user=${a.username}`, `/api/og/achievement/${ach.slug}`, `/api/og/achievement/${ach.slug}?user=${banned.username}`]) {
        expect((await get(path)).status, path).toBe(404)
      }
    })

    it('has no card for someone who turned their cards off', async () => {
      const a = await person({ name: 'Private Holder' })
      const ach = await achievement()
      await testPrisma.userAchievement.create({ data: { userId: a.id, achievementId: ach.id } })
      expect(await achievementCard(testPrisma, ach.slug, a.username)).not.toBeNull()
      await testPrisma.profile.upsert({ where: { userId: a.id }, create: { userId: a.id, showCardsOnWeb: false }, update: { showCardsOnWeb: false } })
      expect(await achievementCard(testPrisma, ach.slug, a.username)).toBeNull()
      expect((await get(`/api/og/achievement/${ach.slug}?user=${a.username}`)).status).toBe(404)
    })

    it('has no card for a minor', async () => {
      const kid = await person({ name: 'Young Person', birthDate: bornYearsAgo(16, 40) })
      const ach = await achievement()
      await testPrisma.userAchievement.create({ data: { userId: kid.id, achievementId: ach.id } })
      expect(await achievementCard(testPrisma, ach.slug, kid.username)).toBeNull()
    })
  })

  it('limits how many cards one address can ask for in a minute', async () => {
    const ip = syntheticIp()
    let limited = 0
    for (let i = 0; i < 70; i++) {
      const res = await fetch(`${INTEGRATION_BASE_URL}/api/og/passport/nobody-${i}`, { headers: { 'x-forwarded-for': ip } })
      await res.arrayBuffer()
      if (res.status === 429) limited += 1
    }
    expect(limited).toBeGreaterThan(0)
  })
})
