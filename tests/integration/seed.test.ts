import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { INTEGRATION_DB_ADMIN_URL, INTEGRATION_DB_NAME } from './config'

// The seed (prisma/seed): run for real, as a person would, against a database of its own, never the suite's. It builds the world, does nothing on a second run, builds the same people again
// after --reset, makes the synthetic romance people only when asked, builds a polished demo account, and refuses to touch production or a database that is not on this machine.
describe('the seed', () => {
  const root = path.resolve(__dirname, '../..')
  const dbName = `${INTEGRATION_DB_NAME}_seed`
  const base = INTEGRATION_DB_ADMIN_URL.replace(/\/postgres\?schema=public$/, '')
  const url = `${base}/${dbName}?schema=public`
  let db: PrismaClient

  const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync('npx', ['tsx', script, ...args], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 600_000,
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: undefined, VERCEL_ENV: undefined, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_seed', CLERK_SECRET_KEY: 'sk_test_seed', ...env } as NodeJS.ProcessEnv,
    })

  beforeAll(async () => {
    const admin = new PrismaClient({ datasources: { db: { url: INTEGRATION_DB_ADMIN_URL } } })
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`)
    } finally {
      await admin.$disconnect()
    }
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' })
    db = new PrismaClient({ datasources: { db: { url } } })
  }, 180_000)

  afterAll(async () => {
    await db.$disconnect()
    const admin = new PrismaClient({ datasources: { db: { url: INTEGRATION_DB_ADMIN_URL } } })
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } finally {
      await admin.$disconnect()
    }
  }, 60_000)

  const usernames = async () => (await db.user.findMany({ where: { id: { startsWith: 'sd_u' } }, select: { username: true }, orderBy: { username: 'asc' } })).map((u) => u.username)

  describe('refusing', () => {
    it('refuses a production environment and leaves the database alone', () => {
      for (const env of [{ NODE_ENV: 'production' }, { VERCEL_ENV: 'production' }]) {
        const result = run('prisma/seed.ts', ['--scale', '50'], env)
        expect(result.status, JSON.stringify(env)).toBe(1)
        expect(result.stderr).toMatch(/production/)
        const demo = run('prisma/seed-demo.ts', ['--username', 'nope'], env)
        expect(demo.status).toBe(1)
        expect(demo.stderr).toMatch(/production/)
      }
    }, 120_000)

    it('refuses a database that is not on this machine, without connecting to it or printing its credentials', () => {
      const result = run('prisma/seed.ts', [], { DATABASE_URL: 'postgresql://someone:hunter2@db.example.com:5432/preview' })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/not on this machine/)
      expect(result.stderr + result.stdout).not.toContain('hunter2')
    }, 60_000)

    it('refuses what it does not understand', () => {
      expect(run('prisma/seed.ts', ['--scale', 'lots']).status).toBe(1)
      expect(run('prisma/seed-demo.ts', ['--username', 'Bad Name']).status).toBe(1)
      expect(run('prisma/seed-demo.ts', []).status).toBe(1)
    }, 120_000)
  })

  describe('the world', () => {
    let firstNames: string[] = []

    it('is built through the domain functions, and consistent', async () => {
      const result = run('prisma/seed.ts', ['--scale', '120', '--days', '30'])
      expect(result.status, result.stderr + result.stdout.slice(-2000)).toBe(0)

      expect(await db.user.count({ where: { id: { startsWith: 'sd_u' } } })).toBe(120)
      expect(await db.user.count({ where: { email: { endsWith: '@seed.skilldating.test' } } })).toBe(120)
      // Twelve cities, with time zones that match.
      const places = await db.profile.groupBy({ by: ['cityKey'], where: { userId: { startsWith: 'sd_u' }, cityKey: { not: null } } })
      expect(places.length).toBeGreaterThanOrEqual(9)
      // XP is exactly what the log says, for everybody, and levels follow.
      const mismatched = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "User" u LEFT JOIN (SELECT "userId", sum(amount) s FROM "XPEvent" GROUP BY 1) x ON x."userId" = u.id WHERE u.id LIKE 'sd\_%' AND u.xp <> coalesce(x.s, 0)`
      expect(Number(mismatched[0].n)).toBe(0)
      expect(await db.xPEvent.count({ where: { type: 'ACHIEVEMENT_EARNED' } })).toBeGreaterThan(0)
      expect(await db.userAchievement.count()).toBeGreaterThan(20)
      expect(Number((await db.user.aggregate({ _max: { longestStreak: true } }))._max.longestStreak)).toBeGreaterThanOrEqual(7)

      // History runs back in time: the oldest award is weeks old, the newest is not in the future.
      const range = await db.xPEvent.aggregate({ _min: { createdAt: true }, _max: { createdAt: true } })
      expect(Date.now() - range._min.createdAt!.getTime()).toBeGreaterThan(20 * 24 * 3_600_000)
      expect(range._max.createdAt!.getTime()).toBeLessThanOrEqual(Date.now())

      // Projects in more than one status, posts of every kind with Props and comments, matches with conversations.
      expect((await db.project.groupBy({ by: ['status'] })).length).toBeGreaterThanOrEqual(4)
      expect((await db.shipPost.groupBy({ by: ['kind'] })).length).toBe(4)
      expect(await db.prop.count()).toBeGreaterThan(50)
      expect(await db.comment.count()).toBeGreaterThan(20)
      expect(await db.match.count({ where: { conversationId: { not: null } } })).toBeGreaterThan(0)
      expect(await db.drop.count()).toBeGreaterThan(100)

      // Hackathons: native and external; ended, active, upcoming and cancelled; squads with pledges and reviews.
      expect((await db.hackathon.groupBy({ by: ['status'] })).map((g) => g.status).sort()).toEqual(['ACTIVE', 'CANCELLED', 'ENDED', 'UPCOMING'])
      expect((await db.hackathon.groupBy({ by: ['source'] })).length).toBe(2)
      expect(await db.teamSlot.count({ where: { status: 'OPEN' } })).toBeGreaterThan(0)
      expect(await db.teamSlot.count({ where: { status: 'FILLED' } })).toBeGreaterThan(0)
      expect(await db.commitmentPledge.count()).toBeGreaterThan(0)
      expect(await db.lfgPost.count()).toBeGreaterThan(0)
      // Invites, reports in the queue, a Ship Day recap, a season, metrics for the admin pages.
      expect(await db.inviteRedemption.count()).toBeGreaterThan(0)
      expect(await db.report.count({ where: { status: { in: ['PENDING', 'REVIEWING'] } } })).toBeGreaterThan(0)
      expect(await db.metricsSnapshot.count()).toBeGreaterThan(100)
      expect(await db.season.count({ where: { active: true } })).toBe(1)

      // Minors have no cards, no city; a college address is never stored; nothing is waiting to be mailed.
      const minors = await db.user.findMany({ where: { id: { startsWith: 'sd_u' }, birthDate: { gt: new Date(Date.now() - 18 * 365.25 * 24 * 3_600_000) } }, select: { id: true, profile: { select: { showCardsOnWeb: true, cityKey: true } } } })
      for (const minor of minors) expect(minor.profile).toMatchObject({ showCardsOnWeb: false, cityKey: null })
      const memberships = await db.campusMembership.findMany({ select: { emailHash: true } })
      expect(memberships.length).toBeGreaterThan(0)
      for (const membership of memberships) expect(membership.emailHash).not.toContain('@')
      expect(await db.notification.count({ where: { userId: { startsWith: 'sd_u' }, sweptAt: null } })).toBe(0)
      expect(await db.emailSuppression.count()).toBe(0)
      // The romance mode is closed, and there is nobody in it.
      expect(await db.romanceProfile.count()).toBe(0)
      expect((await db.featureFlag.findUniqueOrThrow({ where: { key: 'romance.enabled' } })).enabled).toBe(false)
      firstNames = await usernames()
    }, 600_000)

    it('does nothing the second time', async () => {
      const before = { users: await db.user.count(), xp: await db.xPEvent.count(), posts: await db.shipPost.count() }
      const result = run('prisma/seed.ts', ['--scale', '120', '--days', '30'])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/already built/)
      expect({ users: await db.user.count(), xp: await db.xPEvent.count(), posts: await db.shipPost.count() }).toEqual(before)
      // Other settings are not silently mixed in.
      const other = run('prisma/seed.ts', ['--scale', '150'])
      expect(other.status).toBe(0)
      expect(other.stdout).toMatch(/--reset/)
      expect(await db.user.count()).toBe(before.users)
    }, 120_000)

    it('builds the same people again after --reset, and the synthetic romance people only when asked', async () => {
      const result = run('prisma/seed.ts', ['--scale', '120', '--days', '30', '--reset', '--with-romance'])
      expect(result.status, result.stderr + result.stdout.slice(-2000)).toBe(0)
      expect((await usernames()).sort()).toEqual([...firstNames].sort())
      // Forty synthetic adults, aged 25 and over, who say they are synthetic, on the allowlist of a flag that is still off.
      const people = await db.user.findMany({ where: { id: { startsWith: 'sd_r' } }, select: { id: true, name: true, bio: true, birthDate: true } })
      expect(people).toHaveLength(40)
      for (const person of people) {
        expect(person.name).toMatch(/Synthetic/)
        expect(person.bio).toMatch(/Synthetic/)
        expect(Date.now() - person.birthDate!.getTime()).toBeGreaterThanOrEqual(25 * 365.25 * 24 * 3_600_000)
      }
      expect(await db.romanceProfile.count()).toBe(40)
      expect(await db.romancePhoto.count()).toBe(0)
      const flag = await db.featureFlag.findUniqueOrThrow({ where: { key: 'romance.enabled' } })
      expect(flag.enabled).toBe(false)
      expect(flag.allowUserIds).toHaveLength(40)
      // A reset removes them from the allowlist with the rest of the world.
      const reset = run('prisma/seed.ts', ['--scale', '120', '--days', '30', '--reset'])
      expect(reset.status, reset.stderr).toBe(0)
      expect((await db.featureFlag.findUniqueOrThrow({ where: { key: 'romance.enabled' } })).allowUserIds).toHaveLength(0)
      expect(await db.romanceProfile.count()).toBe(0)
    }, 900_000)
  })

  describe('the demo account', () => {
    it('is polished: a passport with proof, a live streak, rare achievements, a squad, matches and a card', async () => {
      const result = run('prisma/seed-demo.ts', ['--username', 'demo-tester', '--name', 'Demo Tester'])
      expect(result.status, result.stderr + result.stdout.slice(-2000)).toBe(0)
      const user = await db.user.findUniqueOrThrow({ where: { username: 'demo-tester' }, include: { profile: true } })
      expect(user.email).toBe('demo-tester@demo.skilldating.test')
      expect(user.currentStreak).toBeGreaterThanOrEqual(44)
      expect(user.xp).toBeGreaterThan(2000)
      expect(user.githubConnected).toBe(true)
      expect(user.profile?.showCardsOnWeb).toBe(true)
      const projects = await db.project.groupBy({ by: ['status'], where: { ownerId: user.id } })
      expect(projects.find((p) => p.status === 'SHIPPED')?._count).toBe(3)
      expect(await db.userAchievement.count({ where: { userId: user.id } })).toBeGreaterThan(10)
      expect(await db.skillEvidence.count({ where: { userId: user.id, type: 'PEER_ENDORSEMENT' } })).toBeGreaterThan(5)
      expect(await db.follow.count({ where: { followeeId: user.id } })).toBeGreaterThan(50)
      expect(await db.teamMember.count({ where: { userId: user.id, role: 'OWNER', team: { hackathon: { status: 'UPCOMING' } } } })).toBe(1)
      expect(await db.teamSlot.count({ where: { team: { ownerId: user.id }, status: 'OPEN' } })).toBe(1)
      expect(await db.match.count({ where: { OR: [{ userAId: user.id }, { userBId: user.id }] } })).toBeGreaterThan(0)
      expect(await db.drop.count({ where: { userId: user.id, status: 'NEW' } })).toBeGreaterThan(0)
      // Running it again rebuilds the account instead of failing or duplicating it.
      const again = run('prisma/seed-demo.ts', ['--username', 'demo-tester'])
      expect(again.status, again.stderr).toBe(0)
      expect(await db.user.count({ where: { username: 'demo-tester' } })).toBe(1)
    }, 600_000)
  })
})
