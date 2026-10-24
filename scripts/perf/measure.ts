/**
 * npm run perf:measure -- --label before [--users 10] [--rounds 30] [--port 3470] [--skip-build] [--plans]
 *
 * Measures the API the way a browser meets it: a production build of the app is started against the 10,000-person database (npm run seed -- --scale 10000), real Clerk sessions
 * (development instance) are made for ten of the seeded people, and every scenario is requested many times by those people. Writes docs/perf/<label>.json (p50, p95, p99 by scenario)
 * and, with --plans, the slowest statements with their plans from Postgres's auto_explain. docs/PERFORMANCE.md explains how to read it.
 *
 * It refuses anything but a local database, creates (and at the end deletes) ten users on the Clerk development instance, never prints a key or a token.
 */
import { spawn, execSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { performance } from 'perf_hooks'
import { PrismaClient } from '@prisma/client'
import { createClerkUser, createSession, deleteClerkUser, mintToken } from '../../tests/integration/clerk-api'
import { loadEnvLocal } from '../../tests/integration/env'
import { readPlans, statsOf, type Stats } from './lib'

const ROOT = path.resolve(__dirname, '../..')
const argv = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const index = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (index < 0) return fallback
  return argv[index].includes('=') ? argv[index].split('=').slice(1).join('=') : (argv[index + 1] ?? fallback)
}
const has = (name: string) => argv.includes(`--${name}`)

const LABEL = flag('label', 'run')
const USERS = Number(flag('users', '10'))
const ROUNDS = Number(flag('rounds', '30'))
const PORT = Number(flag('port', '3470'))
const DATABASE_URL = process.env.PERF_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/skill_dating_perf?schema=public'
const DIST = '.next-perf'
const PG_LOG = process.env.PG_LOG_FILE || '/opt/homebrew/var/log/postgresql@16.log'

interface Actor {
  index: number
  userId: string
  username: string
  clerkId: string
  sessionId: string
  token: string
  mintedAt: number
  admin: boolean
  cityKey: string | null
  countryCode: string | null
  campusKey: string | null
  postIds: string[]
  projectId: string | null
  notificationId: string | null
}

interface World {
  upcomingHackathonId: string
  pastHackathonId: string
  foreignPostIds: string[]
  foreignUserIds: string[]
  searchTerms: string[]
}

interface Scenario {
  name: string
  group: 'read' | 'write' | 'compute'
  method: 'GET' | 'POST' | 'PATCH'
  path: (world: World, actor: Actor, i: number) => string
  body?: (world: World, actor: Actor, i: number) => unknown
  admin?: boolean
  /** Requests per person (default ROUNDS). */
  rounds?: number
}

const SCENARIOS: Scenario[] = [
  { name: 'feed: for-you', group: 'read', method: 'GET', path: () => '/api/feed?tab=for-you&limit=20' },
  { name: 'feed: following', group: 'read', method: 'GET', path: () => '/api/feed?tab=following&limit=20' },
  { name: 'feed: city', group: 'read', method: 'GET', path: () => '/api/feed?tab=city&limit=20' },
  { name: 'feed: campus', group: 'read', method: 'GET', path: () => '/api/feed?tab=campus&limit=20' },
  { name: 'drops: today', group: 'read', method: 'GET', path: () => '/api/drops/today' },
  { name: 'leaderboard: global weekly', group: 'read', method: 'GET', path: () => '/api/leaderboard?scope=global&period=weekly' },
  { name: 'leaderboard: global all-time', group: 'read', method: 'GET', path: () => '/api/leaderboard?scope=global&period=all-time' },
  { name: 'leaderboard: city season', group: 'read', method: 'GET', path: (_w, a) => `/api/leaderboard?scope=city&period=season${a.cityKey && a.countryCode ? `&scopeId=${a.countryCode}:${a.cityKey}` : ''}` },
  { name: 'leaderboard: campus', group: 'read', method: 'GET', path: (_w, a) => `/api/leaderboard?scope=campus&period=all-time${a.campusKey ? `&scopeId=${a.campusKey}` : ''}` },
  { name: 'heatmap', group: 'read', method: 'GET', path: (_w, a) => `/api/users/${a.userId}/heatmap?days=365` },
  { name: 'stats (player card)', group: 'read', method: 'GET', path: (_w, a) => `/api/users/${a.userId}/stats` },
  { name: 'passport (user profile)', group: 'read', method: 'GET', path: (w, _a, i) => `/api/users/${w.foreignUserIds[i % w.foreignUserIds.length]}` },
  { name: 'discover', group: 'read', method: 'GET', path: () => '/api/discover?limit=20' },
  { name: 'discover: text search', group: 'read', method: 'GET', path: (w, _a, i) => `/api/discover?limit=20&search=${encodeURIComponent(w.searchTerms[i % w.searchTerms.length])}` },
  { name: 'search (command palette)', group: 'read', method: 'GET', path: (w, _a, i) => `/api/search?q=${encodeURIComponent(w.searchTerms[i % w.searchTerms.length])}` },
  { name: 'lfg board', group: 'read', method: 'GET', path: (w) => `/api/hackathons/${w.upcomingHackathonId}/lfg?limit=20` },
  { name: 'hackathons list', group: 'read', method: 'GET', path: () => '/api/hackathons?limit=20' },
  { name: 'notifications list', group: 'read', method: 'GET', path: () => '/api/notifications?limit=20' },
  { name: 'dashboard (today)', group: 'read', method: 'GET', path: () => '/api/dashboard' },
  { name: 'moderation queue', group: 'read', method: 'GET', path: () => '/api/admin/queue?kind=reports&limit=25', admin: true },
  { name: 'admin metrics', group: 'read', method: 'GET', path: () => '/api/admin/metrics', admin: true },
  { name: 'squad builder (propose)', group: 'compute', method: 'POST', path: (w) => `/api/hackathons/${w.upcomingHackathonId}/squad-builder`, body: (_w, _a, i) => ({ size: 4, seed: i + 1 }), rounds: 2 },
  { name: 'write: post an update', group: 'write', method: 'POST', path: () => '/api/posts', body: (_w, a, i) => ({ kind: 'UPDATE', title: `Perf ${i} ${Date.now() % 100000}`, body: `Measuring a post number ${i}.`, ...(a.projectId ? { projectId: a.projectId } : {}), links: [], mediaIds: [], stackTags: [], coAuthorIds: [], visibility: 'PUBLIC' }), rounds: 12 },
  { name: 'write: give Props', group: 'write', method: 'POST', path: (w, _a, i) => `/api/posts/${w.foreignPostIds[i % w.foreignPostIds.length]}/props`, rounds: 20 },
  { name: 'write: comment', group: 'write', method: 'POST', path: (w, _a, i) => `/api/posts/${w.foreignPostIds[(i + 7) % w.foreignPostIds.length]}/comments`, body: (_w, _a, i) => ({ body: `Nice work, number ${i}.` }), rounds: 15 },
  { name: 'write: mark a notification read', group: 'write', method: 'PATCH', path: (_w, a) => `/api/notifications/${a.notificationId}`, body: () => ({ isRead: true }), rounds: 5 },
  { name: 'write: follow', group: 'write', method: 'POST', path: (w, _a, i) => `/api/users/${w.foreignUserIds[(i * 3) % w.foreignUserIds.length]}/follow`, rounds: 12 },
  { name: 'write: solo pool preferences', group: 'write', method: 'PATCH', path: (w) => `/api/hackathons/${w.upcomingHackathonId}/participation`, body: (_w, _a, i) => ({ lookingForTeam: i % 2 === 0, openToAutoTeam: true }), rounds: 6 },
]

async function main() {
  const database = new URL(DATABASE_URL)
  if (!['localhost', '127.0.0.1'].includes(database.hostname)) throw new Error('perf:measure measures a database on this machine only')
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to run in production')
  const env = { ...process.env, ...loadEnvLocal(ROOT) }
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  const clerkIds: string[] = []
  let server: ChildProcess | undefined
  try {
    const counts = await tableCounts(db)
    console.log(`Database ${database.pathname.slice(1)}: ${counts.User} users, ${counts.XPEvent} XP events, ${counts.ShipPost} posts, ${counts.Prop} Props, ${counts.Follow} follows`)
    if (counts.User < 5000) console.log('  (fewer than 5,000 people: run npm run seed -- --scale 10000 on this database first for numbers that mean anything)')

    if (has('plans')) await enablePlanLogging(db, database.pathname.slice(1))

    if (!has('skip-build') || !fs.existsSync(path.join(ROOT, DIST, 'BUILD_ID'))) {
      console.log('Building the app (production)...')
      execSync('npx next build', { cwd: ROOT, env: { ...env, NODE_ENV: 'production', NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY } as NodeJS.ProcessEnv, stdio: 'ignore' })
    }

    const world = await loadWorld(db)
    const actors = await makeActors(db, world, clerkIds)
    const logOffset = fs.existsSync(PG_LOG) ? fs.statSync(PG_LOG).size : 0

    console.log(`Starting the server on :${PORT} against the perf database...`)
    server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
      cwd: ROOT,
      env: { ...env, DATABASE_URL, NODE_ENV: 'production', VERCEL_ENV: 'preview', NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: '1', TRUSTED_PROXY_HOPS: '1', APP_URL: `http://localhost:${PORT}`, NOTIFICATION_SIGNING_SECRET: 'perf-run-signing-secret-perf-run-signing-secret' } as NodeJS.ProcessEnv,
      stdio: 'ignore',
      detached: true,
    })
    await waitUntilUp(`http://localhost:${PORT}/api/health`)

    const results: Record<string, { group: string; stats: Stats; ok: number; statuses: Record<string, number> }> = {}
    for (const scenario of SCENARIOS) {
      const people = actors.filter((actor) => (scenario.admin ? actor.admin : !actor.admin || !scenario.admin)).slice(0, scenario.admin ? 1 : USERS)
      const rounds = scenario.rounds ?? ROUNDS
      // A first request per scenario warms the route (and the database's cache) and is not counted.
      await timed(scenario, world, people[0], 0, `http://localhost:${PORT}`).catch(() => undefined)
      const samples: number[] = []
      const statuses: Record<string, number> = {}
      const lanes = people.map(async (actor) => {
        for (let i = 1; i <= rounds; i++) {
          const outcome = await timed(scenario, world, actor, i, `http://localhost:${PORT}`)
          statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1
          if (outcome.status >= 200 && outcome.status < 300) samples.push(outcome.ms)
        }
      })
      // Three people at a time, so the database sees some company without the rate limits being the thing measured.
      for (let start = 0; start < lanes.length; start += 3) await Promise.all(lanes.slice(start, start + 3))
      const ok = samples.length
      results[scenario.name] = { group: scenario.group, stats: statsOf(samples), ok, statuses }
      const stats = results[scenario.name].stats
      console.log(`${scenario.name.padEnd(34)} p50 ${String(stats.p50).padStart(7)} ms   p95 ${String(stats.p95).padStart(7)} ms   p99 ${String(stats.p99).padStart(7)} ms   ok ${ok}/${Object.values(statuses).reduce((a, b) => a + b, 0)} ${Object.keys(statuses).filter((s) => !s.startsWith('2')).length ? JSON.stringify(statuses) : ''}`)
    }

    const output = {
      label: LABEL,
      measuredAt: new Date().toISOString(),
      machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
      database: { name: database.pathname.slice(1), counts },
      method: { users: USERS, roundsPerUser: ROUNDS, concurrency: 3, server: 'next start (production build), in-memory cache and job queue', timingNote: 'wall time of the HTTP request from the same machine, body included' },
      scenarios: results,
    }
    fs.mkdirSync(path.join(ROOT, 'docs/perf'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'docs/perf', `${LABEL}.json`), JSON.stringify(output, null, 2) + '\n')
    console.log(`Wrote docs/perf/${LABEL}.json`)

    if (has('plans')) {
      const plans = readPlans(PG_LOG, logOffset)
      const file = flag('plans-out', path.join(os.tmpdir(), `perf-plans-${LABEL}.txt`))
      fs.writeFileSync(file, plans.slice(0, 40).map((entry) => `### ${entry.count}x, total ${entry.totalMs.toFixed(0)} ms, worst ${entry.maxMs.toFixed(1)} ms\n${entry.query}\n\n${entry.plan}\n`).join('\n'))
      console.log(`Wrote the ${Math.min(40, plans.length)} slowest statements (of ${plans.length}) with their plans to ${file}`)
    }
  } finally {
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    for (const id of clerkIds) await deleteClerkUser(id).catch(() => undefined)
    await db.$disconnect()
  }
}

async function tableCounts(db: PrismaClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ['User', 'XPEvent', 'ShipPost', 'Prop', 'Comment', 'Follow', 'Notification', 'Drop', 'Spark', 'Project', 'HackathonParticipant', 'ActivityDay']) {
    const [row] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`)
    out[table] = Number(row.n)
  }
  return out
}

async function enablePlanLogging(db: PrismaClient, name: string): Promise<void> {
  // Plans of statements slower than 20 ms, with real timings, go to the server log for every new connection to this database.
  await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET session_preload_libraries = 'auto_explain'`)
  await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET auto_explain.log_min_duration = '20ms'`)
  await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET auto_explain.log_analyze = on`)
  await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET auto_explain.log_buffers = on`)
  await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET auto_explain.log_nested_statements = off`)
}

async function loadWorld(db: PrismaClient): Promise<World> {
  const upcoming = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT h.id FROM "Hackathon" h WHERE h.status = 'UPCOMING' AND h.slug LIKE 'seed-%' ORDER BY (SELECT count(*) FROM "HackathonParticipant" p WHERE p."hackathonId" = h.id) DESC LIMIT 1`)
  const past = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Hackathon" WHERE status = 'ENDED' AND slug LIKE 'seed-%' ORDER BY "startDate" DESC LIMIT 1`)
  const posts = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "ShipPost" WHERE "authorId" LIKE 'sd\\_u%' AND "deletedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 400`)
  const users = await db.$queryRawUnsafe<{ id: string; name: string | null }[]>(`SELECT id, name FROM "User" WHERE id LIKE 'sd\\_u%' ORDER BY xp DESC LIMIT 300`)
  const terms = new Set<string>(['react', 'rust', 'founder', 'design', 'machine learning', 'berlin', 'hackathon', 'api'])
  for (const user of users.slice(0, 40)) if (user.name) terms.add(user.name.split(' ')[0].toLowerCase())
  return { upcomingHackathonId: upcoming[0].id, pastHackathonId: past[0]?.id ?? upcoming[0].id, foreignPostIds: posts.map((p) => p.id), foreignUserIds: users.map((u) => u.id), searchTerms: [...terms] }
}

async function makeActors(db: PrismaClient, world: World, clerkIds: string[]): Promise<Actor[]> {
  // People with a lot to show (they are the ones whose pages are slowest), spread over cities, one of them an admin for the admin pages.
  const rows = await db.$queryRawUnsafe<{ id: string; username: string; cityKey: string | null; countryCode: string | null; campusKey: string | null }[]>(
    `SELECT u.id, u.username, p."cityKey", p."countryCode", p."campusKey" FROM "User" u JOIN "Profile" p ON p."userId" = u.id WHERE u.id LIKE 'sd\\_u%' AND u."createdAt" < now() - interval '30 days' ORDER BY u.xp DESC LIMIT 400`
  )
  const chosen: typeof rows = []
  const seenCities = new Set<string>()
  for (const row of rows) {
    const city = row.cityKey ?? 'none'
    if (chosen.length < USERS + 1 && (!seenCities.has(city) || chosen.length >= 12)) {
      chosen.push(row)
      seenCities.add(city)
    }
  }
  for (const row of rows) if (chosen.length < USERS + 1 && !chosen.includes(row)) chosen.push(row)
  const actors: Actor[] = []
  for (const [index, row] of chosen.entries()) {
    const suffix = `${Date.now().toString(36)}${index}`
    const clerk = await createClerkUser(`perf${suffix}@test.dev`, `perf${suffix}`)
    clerkIds.push(clerk.clerkId)
    const sessionId = await createSession(clerk.clerkId)
    await db.user.update({ where: { id: row.id }, data: { clerkId: clerk.clerkId, ...(index === 0 ? { role: 'ADMIN' } : {}) } })
    const posts = await db.shipPost.findMany({ where: { authorId: row.id, deletedAt: null }, select: { id: true }, take: 5 })
    const project = await db.project.findFirst({ where: { ownerId: row.id, status: { notIn: ['SHIPPED', 'ARCHIVED'] } }, select: { id: true } })
    const notification = await db.notification.findFirst({ where: { userId: row.id, isRead: false }, select: { id: true } })
    actors.push({ index, userId: row.id, username: row.username, clerkId: clerk.clerkId, sessionId, token: '', mintedAt: 0, admin: index === 0, cityKey: row.cityKey, countryCode: row.countryCode, campusKey: row.campusKey, postIds: posts.map((p) => p.id), projectId: project?.id ?? null, notificationId: notification?.id ?? null })
  }
  void world
  return actors
}

async function tokenFor(actor: Actor): Promise<string> {
  if (!actor.token || Date.now() - actor.mintedAt > 40_000) {
    actor.token = await mintToken(actor.sessionId)
    actor.mintedAt = Date.now()
  }
  return actor.token
}

async function timed(scenario: Scenario, world: World, actor: Actor, i: number, base: string): Promise<{ ms: number; status: number }> {
  const token = await tokenFor(actor)
  const body = scenario.body ? JSON.stringify(scenario.body(world, actor, i)) : undefined
  const started = performance.now()
  const res = await fetch(base + scenario.path(world, actor, i), {
    method: scenario.method,
    headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': `10.20.${actor.index}.1`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body,
  })
  await res.arrayBuffer()
  return { ms: performance.now() - started, status: res.status }
}

async function waitUntilUp(url: string): Promise<void> {
  const until = Date.now() + 90_000
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status) return
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('the server did not come up')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
