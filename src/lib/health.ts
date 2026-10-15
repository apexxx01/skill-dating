import type { Cache } from '@/lib/infra/cache'
import type { JobQueue } from '@/lib/infra/jobs'
import type { Realtime } from '@/lib/infra/realtime'

// What GET /api/health reports, for uptime monitors and load balancers. It says
// whether each dependency answers and which implementation is in use, and nothing
// else: no hosts, keys or versions.
//
//  - database is the only one the app cannot serve without: if it is down the
//    status is "down" and the route answers 503, so a load balancer takes the
//    instance out of rotation.
//  - cache, jobs and realtime degrade the service but do not stop it (rate limits
//    fail open, jobs and publishes are retried or skipped), so a failure there is
//    "degraded" and the route still answers 200. A monitor that wants to page on
//    those reads the body.

export type CheckStatus = 'ok' | 'down'

export interface CheckResult {
  status: CheckStatus
  /** Which implementation answered: "postgres", "memory", "upstash", "inngest", "ably". */
  provider: string
  /** Only for checks that actually called the dependency. */
  latencyMs?: number
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down'
  time: string
  checks: {
    database: CheckResult
    cache: CheckResult
    jobs: CheckResult
    realtime: CheckResult
  }
}

export interface HealthDeps {
  /** Resolves when the database answers a trivial query. */
  pingDatabase(): Promise<void>
  cache(): Cache
  jobs(): JobQueue
  realtime(): Realtime
}

export const HEALTH_CHECK_TIMEOUT_MS = 2_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function probe(provider: string, call: () => Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now()
  try {
    await withTimeout(call(), timeoutMs)
    return { status: 'ok', provider, latencyMs: Date.now() - started }
  } catch {
    return { status: 'down', provider, latencyMs: Date.now() - started }
  }
}

// A provider that cannot even be created (bad configuration) is a failed check, not a crash.
async function providerCheck<T extends { kind: string }>(
  get: () => T,
  unknownProvider: string,
  call: (provider: T) => Promise<unknown> | undefined,
  timeoutMs: number
): Promise<CheckResult> {
  let provider: T
  try {
    provider = get()
  } catch {
    return { status: 'down', provider: unknownProvider }
  }
  const work = call(provider)
  return work ? probe(provider.kind, () => work, timeoutMs) : { status: 'ok', provider: provider.kind }
}

export async function runHealthChecks(deps: HealthDeps, options: { timeoutMs?: number; now?: () => Date } = {}): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS

  const [database, cache, jobs, realtime] = await Promise.all([
    probe('postgres', () => deps.pingDatabase(), timeoutMs),
    providerCheck(deps.cache, 'unknown', (cache) => cache.ping(), timeoutMs),
    // The job queue has nothing to call without enqueueing real work, so it reports its configuration.
    providerCheck(deps.jobs, 'unknown', () => undefined, timeoutMs),
    // Signing a token request is local, but it does fail on a broken key.
    providerCheck(deps.realtime, 'unknown', (realtime) => realtime.issueToken('health-check', ['user:health-check'], 1_000), timeoutMs),
  ])

  const status = database.status === 'down' ? 'down' : [cache, jobs, realtime].some((check) => check.status === 'down') ? 'degraded' : 'ok'
  return { status, time: (options.now?.() ?? new Date()).toISOString(), checks: { database, cache, jobs, realtime } }
}

export function healthStatusCode(report: HealthReport): number {
  return report.status === 'down' ? 503 : 200
}
