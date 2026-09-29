import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'

// Integration tests run against a real Next.js dev server and a real,
// disposable Postgres database - not mocks. They exercise the actual HTTP
// routes exactly as a client would, which is the only way to catch the
// class of bug this suite exists for (transaction races, auth holes,
// double-awards on repeat calls) - a unit test with a mocked Prisma client
// can't reproduce any of those.
export const INTEGRATION_BASE_URL = 'http://localhost:3459'
const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/skill_dating_integration?schema=public'

let serverProcess: ChildProcess | undefined

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url + '/api/auth/csrf')
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

// Next.js does not auto-load .env.local when NODE_ENV=test (a deliberate
// Next.js safety default, so a test run never silently picks up dev
// secrets) - and vitest sets NODE_ENV=test. Without this, the spawned dev
// server has no NEXTAUTH_SECRET and every auth route 500s with
// "MissingSecret". Parsed and merged in manually instead.
function loadEnvLocal(projectRoot: string): Record<string, string> {
  const envPath = path.join(projectRoot, '.env.local')
  const vars: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return vars
  const contents = fs.readFileSync(envPath, 'utf-8')
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return vars
}

export default async function setup() {
  const projectRoot = path.resolve(__dirname, '../..')
  const envLocal = loadEnvLocal(projectRoot)

  // `prisma db push` creates the target Postgres database if it doesn't
  // already exist (confirmed live) and syncs the schema either way - so
  // this suite needs nothing beyond a reachable Postgres server, not a
  // pre-created database.
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  })

  // Spawned directly via `next dev`, not `npm run dev` - npm's own wrapper
  // process doesn't reliably propagate a kill signal down to the actual
  // next-server child it launches (confirmed the hard way earlier in this
  // project's history: `pkill`-ing the npm wrapper left next-server running
  // on the port). `detached: true` + killing the negative PID takes out the
  // whole process group Next spawns, not just the immediate child.
  // Override NODE_ENV rather than inheriting vitest's 'test' - 'next dev'
  // otherwise runs against a test-mode Next.js build that behaves
  // differently in ways unrelated to the actual env-loading fix above.
  const childEnv = { ...process.env, ...envLocal, DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'development' as const }

  serverProcess = spawn('npx', ['next', 'dev', '-p', '3459'], {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'ignore',
    detached: true,
  })

  await waitForServer(INTEGRATION_BASE_URL, 30_000)

  return async function teardown() {
    if (serverProcess && !serverProcess.killed && serverProcess.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM')
      } catch {
        // process group may already be gone
      }
    }
  }
}
