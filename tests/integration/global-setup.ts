import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL, INTEGRATION_DB_NAME, INTEGRATION_DB_ADMIN_URL, INTEGRATION_FIXTURE_PORT, INTEGRATION_PORT } from './config'
import { loadEnvLocal } from './env'
import { clerkSecretKey, deleteRegisteredUsers, sweepStaleTestUsers } from './clerk-api'

// Integration tests run against a real Next.js dev server and a real,
// disposable Postgres database - not mocks. They exercise the actual HTTP
// routes exactly as a client would, which is the only way to catch the
// class of bug this suite exists for (transaction races, auth holes,
// double-awards on repeat calls) - a unit test with a mocked Prisma client
// can't reproduce any of those.
export { INTEGRATION_BASE_URL }
const TEST_DATABASE_URL = INTEGRATION_DATABASE_URL

let serverProcess: ChildProcess | undefined

// DROP/CREATE DATABASE cannot run against the database being dropped, so this
// connects to the server's maintenance database. The name is validated in
// config.ts to letters, digits and underscores, so interpolating it is safe.
async function recreateDatabase() {
  const admin = new PrismaClient({ datasources: { db: { url: INTEGRATION_DB_ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${INTEGRATION_DB_NAME}" WITH (FORCE)`)
    await admin.$executeRawUnsafe(`CREATE DATABASE "${INTEGRATION_DB_NAME}"`)
  } finally {
    await admin.$disconnect()
  }
}

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url + '/api/auth/session')
        if (res.status) {
          resolve()
          return
        }
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`))
        return
      }
      setTimeout(attempt, 500)
    }
    attempt()
  })
}

export default async function setup() {
  const projectRoot = path.resolve(__dirname, '../..')
  const envLocal = loadEnvLocal(projectRoot)

  // Real Clerk users are created on the development instance, so fail before
  // starting anything if the key is missing or is not a development key, and
  // clear out harness users a crashed earlier run left behind.
  Object.assign(process.env, { CLERK_SECRET_KEY: clerkSecretKey() })
  await sweepStaleTestUsers()

  // Registry of the Clerk users this run creates (test workers append to it,
  // teardown deletes them), and a webhook secret that exists only for this run:
  // the spawned server verifies with it and the webhook tests sign with it.
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dating-clerk-')), 'users.jsonl')
  fs.writeFileSync(registry, '')
  const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`
  process.env.TEST_CLERK_REGISTRY = registry
  process.env.TEST_CLERK_WEBHOOK_SECRET = webhookSecret

  // Fail loudly if something already answers on the port. Otherwise the
  // readiness check below would happily succeed against someone else's server
  // and the whole suite would run against the wrong database.
  const occupied = await fetch(INTEGRATION_BASE_URL + '/api/auth/session').then(
    () => true,
    () => false
  )
  if (occupied) {
    throw new Error(
      `Port ${INTEGRATION_PORT} is already serving requests. Set TEST_PORT to a free port; refusing to run against a server this suite did not start.`
    )
  }

  // The database is disposable: dropped and rebuilt from the real migrations on
  // every run, so the suite exercises exactly what `prisma migrate deploy` does
  // in production and never inherits a schema from an earlier run.
  await recreateDatabase()
  execSync('npx prisma migrate deploy', {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  })

  // Quests pay small, random-looking amounts of XP (which ones a user has depends on their id), and most of this
  // suite asserts exact XP totals. They are paused for the suite with the same flag an operator would use, and
  // tests/integration/quests.test.ts switches them back on for its own run.
  const setup = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } })
  try {
    await setup.featureFlag.update({ where: { key: 'quests' }, data: { enabled: false } })
  } finally {
    await setup.$disconnect()
  }

  // Spawned directly via `next dev`, not `npm run dev` - npm's own wrapper
  // process doesn't reliably propagate a kill signal down to the actual
  // next-server child it launches (confirmed the hard way earlier in this
  // project's history: `pkill`-ing the npm wrapper left next-server running
  // on the port). `detached: true` + killing the negative PID takes out the
  // whole process group Next spawns, not just the immediate child.
  // Override NODE_ENV rather than inheriting vitest's 'test' - 'next dev'
  // otherwise runs against a test-mode Next.js build that behaves
  // differently in ways unrelated to the actual env-loading fix above.
  const childEnv = { ...process.env, ...envLocal, DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'development' as const, TRUSTED_PROXY_HOPS: '1', CLERK_WEBHOOK_SECRET: webhookSecret, PAGE_FETCH_ALLOW_PRIVATE: `localhost:${INTEGRATION_FIXTURE_PORT}` }

  // TEST_SERVER_LOG=<file> keeps the dev server's output, for diagnosing a failing run.
  const logPath = process.env.TEST_SERVER_LOG
  const serverLog = logPath ? fs.openSync(logPath, 'w') : 'ignore'

  serverProcess = spawn('npx', ['next', 'dev', '-p', String(INTEGRATION_PORT)], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', serverLog, serverLog],
    detached: true,
  })

  await waitForServer(INTEGRATION_BASE_URL, 30_000)

  return async function teardown() {
    try {
      await deleteRegisteredUsers()
      fs.rmSync(path.dirname(registry), { recursive: true, force: true })
    } catch (error) {
      console.error('could not delete every Clerk test user:', error instanceof Error ? error.message : error)
    }
    if (serverProcess && !serverProcess.killed && serverProcess.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM')
      } catch {
        // process group may already be gone
      }
    }
  }
}
