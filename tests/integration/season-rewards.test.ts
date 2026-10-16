import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { seasonAwardCutoffs, seasonCosmeticSlug, SEASON_AWARDS } from '../../src/lib/cosmetic-definitions'

// What finishing a season earns: cosmetics only, never XP. Granted by the rollover job from the season's final
// standings (and from the log, for the participation badge), once, whatever the number of runs.
describe('season rewards', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let admin: TestUser

  beforeAll(async () => {
    const name = `sr${suffix}`
    admin = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(admin.userId)
  })
  afterAll(() => cleanupTestUsers(suffix), 300_000)

  const rollover = () => req(admin.jar, 'POST', '/api/admin/jobs/seasons/rollover')
  async function scorer(seasonId: string, amounts: number[], over: { hidden?: boolean; deleted?: boolean } = {}) {
    const name = `sx${suffix}${n++}`
    const user = await testPrisma.user.create({ data: { email: `${name}@test.dev`, username: name, name, ...(over.deleted ? { deletedAt: new Date() } : {}) } })
    if (over.hidden) await testPrisma.profile.create({ data: { userId: user.id, hideFromLeaderboards: true } })
    await testPrisma.xPEvent.createMany({ data: amounts.map((amount) => ({ userId: user.id, type: 'TEST', amount, description: 'test', seasonId, dedupeKey: `sr:${n++}:${Math.random()}` })) })
    return user
  }
  const slugsOf = async (userId: string) => (await testPrisma.userCosmetic.findMany({ where: { userId, cosmetic: { slug: { startsWith: 'season-' } } }, select: { cosmetic: { select: { slug: true } } } })).map((row) => row.cosmetic.slug).sort()

  it('grants the title, the frames and the badge by rank and by having played, pays no XP, and does nothing the second time', async () => {
    const season = await testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
    await testPrisma.season.update({ where: { id: season.id }, data: { endsAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } })

    // A real, signed-in winner, and a field of 150 behind them, so every cutoff falls somewhere different.
    const winner = await registerAndLogin(`srw${suffix}@test.dev`, `srw${suffix}`)
    await testPrisma.xPEvent.create({ data: { userId: winner.userId, type: 'TEST', amount: 900_000_000, description: 'test', seasonId: season.id, dedupeKey: `sr:w:${Math.random()}` } })
    const field: { id: string }[] = []
    for (let index = 0; index < 150; index++) field.push(await scorer(season.id, [800_000_000 - index * 1000]))
    const hidden = await scorer(season.id, [5], { hidden: true })
    const gone = await scorer(season.id, [5], { deleted: true })
    const nothing = await scorer(season.id, [50, -50])
    const earlier = await testPrisma.season.create({ data: { number: 800 + n++, name: 'Earlier', startsAt: new Date(0), endsAt: new Date(1), active: false } })
    const elsewhere = await scorer(earlier.id, [10_000])

    const eventsBefore = await testPrisma.xPEvent.count()
    const xpBefore = (await testPrisma.user.findMany({ where: { id: { in: [winner.userId, ...field.map((u) => u.id)] } }, select: { id: true, xp: true } })).map((u) => [u.id, u.xp])

    const res = await rollover()
    expect(res.status).toBe(200)
    expect(res.data.result).toMatchObject({ closed: true, seasonId: season.id })
    const mine = (res.data.result.rewards as { seasonId: string }[]).find((reward) => reward.seasonId === season.id)
    expect(mine).toBeDefined()

    // --- who got what, checked against the standings the season was closed with
    const standings = await testPrisma.seasonStanding.findMany({ where: { seasonId: season.id }, orderBy: { rank: 'asc' } })
    const cutoffs = seasonAwardCutoffs(standings.length)
    expect(standings.length).toBeGreaterThan(150)
    expect(cutoffs.TOP_100).toBe(100)
    const slug = (award: (typeof SEASON_AWARDS)[number]) => seasonCosmeticSlug(season.number, award)
    const ids = standings.map((row) => row.userId)
    const owners = async (award: (typeof SEASON_AWARDS)[number]) =>
      new Set((await testPrisma.userCosmetic.findMany({ where: { userId: { in: ids }, cosmetic: { slug: slug(award) } }, select: { userId: true } })).map((row) => row.userId))
    const [title, apex, strong] = await Promise.all([owners('TOP_100'), owners('TOP_1_PERCENT'), owners('TOP_10_PERCENT')])
    for (const row of standings) {
      expect(title.has(row.userId), `rank ${row.rank} title`).toBe(row.rank <= cutoffs.TOP_100)
      expect(apex.has(row.userId), `rank ${row.rank} top 1%`).toBe(row.rank <= cutoffs.TOP_1_PERCENT)
      expect(strong.has(row.userId), `rank ${row.rank} top 10%`).toBe(row.rank <= cutoffs.TOP_10_PERCENT)
    }
    expect(standings[0].userId).toBe(winner.userId)
    expect(await slugsOf(winner.userId)).toEqual(SEASON_AWARDS.map(slug).sort())

    // The badge: everyone who earned XP in the season, ranked or not; nobody who nets nothing, is deleted, or played another season.
    const played = await testPrisma.userCosmetic.findMany({ where: { cosmetic: { slug: slug('PARTICIPANT') } }, select: { userId: true } })
    const badge = new Set(played.map((row) => row.userId))
    for (const row of standings) expect(badge.has(row.userId)).toBe(true)
    expect(badge.has(hidden.id)).toBe(true) // opted out of leaderboards, but they played
    expect((await slugsOf(hidden.id))).toEqual([slug('PARTICIPANT')]) // and has no placing
    for (const user of [gone, nothing, elsewhere]) expect(badge.has(user.id), user.id).toBe(false)
    expect(await slugsOf(gone.id)).toEqual([])

    // --- no XP, anywhere
    expect(await testPrisma.xPEvent.count()).toBe(eventsBefore)
    const xpAfter = (await testPrisma.user.findMany({ where: { id: { in: [winner.userId, ...field.map((u) => u.id)] } }, select: { id: true, xp: true } })).map((u) => [u.id, u.xp])
    expect(xpAfter).toEqual(xpBefore)

    // --- people are told, once per cosmetic
    const told = await testPrisma.notification.findMany({ where: { userId: winner.userId, title: 'New cosmetic' } })
    expect(told.map((note) => note.message).sort()).toEqual(SEASON_AWARDS.map((award) => `Season ${season.number} ${{ TOP_100: 'Top 100', TOP_1_PERCENT: 'Top 1%', TOP_10_PERCENT: 'Top 10%', PARTICIPANT: 'Participant' }[award]}`).sort())

    // --- the season is marked done, and a second run grants and tells nobody again
    expect((await testPrisma.season.findUniqueOrThrow({ where: { id: season.id } })).rewardsGrantedAt).not.toBeNull()
    const inventory = await testPrisma.userCosmetic.count({ where: { cosmetic: { slug: { startsWith: `season-${season.number}-` } } } })
    const notices = await testPrisma.notification.count({ where: { title: 'New cosmetic', userId: { in: ids } } })
    const again = await rollover()
    expect(again.data.result.rewards.map((reward: { seasonId: string }) => reward.seasonId)).not.toContain(season.id)
    expect(await testPrisma.userCosmetic.count({ where: { cosmetic: { slug: { startsWith: `season-${season.number}-` } } } })).toBe(inventory)
    expect(await testPrisma.notification.count({ where: { title: 'New cosmetic', userId: { in: ids } } })).toBe(notices)

    // --- even if the marker is lost, running it again grants and tells nobody twice
    await testPrisma.season.update({ where: { id: season.id }, data: { rewardsGrantedAt: null } })
    const retried = await rollover()
    expect(retried.data.result.rewards.map((reward: { seasonId: string }) => reward.seasonId)).toContain(season.id)
    expect((retried.data.result.rewards.find((reward: { seasonId: string }) => reward.seasonId === season.id) as { grants: { granted: number }[] }).grants.map((grant) => grant.granted)).toEqual([0, 0, 0, 0])
    expect(await testPrisma.userCosmetic.count({ where: { cosmetic: { slug: { startsWith: `season-${season.number}-` } } } })).toBe(inventory)
    expect(await testPrisma.notification.count({ where: { title: 'New cosmetic', userId: { in: ids } } })).toBe(notices)
    expect((await testPrisma.season.findUniqueOrThrow({ where: { id: season.id } })).rewardsGrantedAt).not.toBeNull()

    // --- and the winner can see and wear what they won
    const list = await req(winner.jar, 'GET', '/api/users/me/cosmetics')
    expect(list.status).toBe(200)
    const owned = list.data.cosmetics.filter((item: { slug: string; owned: boolean }) => item.slug.startsWith('season-') && item.owned).map((item: { slug: string }) => item.slug).sort()
    expect(owned).toEqual(SEASON_AWARDS.map(slug).sort())
    const wear = await req(winner.jar, 'PATCH', '/api/users/me/equipped', { title: slug('TOP_100'), frame: slug('TOP_1_PERCENT') })
    expect(wear.status).toBe(200)
    expect(wear.data.equipped).toMatchObject({ title: slug('TOP_100'), frame: slug('TOP_1_PERCENT') })
    // The badge goes in the badges slot and nowhere else. Another season's title was never earned.
    expect((await req(winner.jar, 'PATCH', '/api/users/me/equipped', { banner: slug('PARTICIPANT') })).status).toBe(400)
    const wearBadge = await req(winner.jar, 'PATCH', '/api/users/me/equipped', { badges: [slug('PARTICIPANT')] })
    expect(wearBadge.status).toBe(200)
    expect(wearBadge.data.equipped.badges).toEqual([slug('PARTICIPANT')])
    expect(list.data.cosmetics.find((item: { slug: string }) => item.slug === slug('PARTICIPANT'))).toMatchObject({ type: 'BADGE', slot: 'badges' })
    expect((await testPrisma.cosmetic.findUniqueOrThrow({ where: { slug: slug('PARTICIPANT') } })).type).toBe('BADGE')
    const foreign = await req(winner.jar, 'PATCH', '/api/users/me/equipped', { title: seasonCosmeticSlug(season.number + 50, 'TOP_100') })
    expect(foreign.status).toBe(403)
  }, 600_000)

  it('does not give a rank-less person a title, and nobody has anything from a season that is still running', async () => {
    const running = await testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
    expect(running.rewardsGrantedAt).toBeNull()
    expect(await testPrisma.userCosmetic.count({ where: { cosmetic: { slug: { startsWith: `season-${running.number}-` } } } })).toBe(0)
    await rollover()
    expect(await testPrisma.userCosmetic.count({ where: { cosmetic: { slug: { startsWith: `season-${running.number}-` } } } })).toBe(0)
  })
})
