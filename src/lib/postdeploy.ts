import type { PrismaClient } from '@prisma/client'
import type { Cache } from '@/lib/infra/cache'
import { requiresProductionConfig } from '@/lib/env'
import { BOARDS_READY_KEY } from '@/lib/leaderboard-write'
import { ensureActiveSeason, grantPendingSeasonRewards } from '@/lib/seasons'

// What has to happen once after every deploy that touches the gamification stage, in one command (`npm run postdeploy`,
// scripts/postdeploy.ts, docs/DEPLOY.md). Every step is safe to repeat, so the command can run on every deploy:
//
//   1. check the environment: production without Upstash Redis FAILS, because the leaderboards live in Redis and a
//      script cannot fill an in-process cache for the web servers;
//   2. make sure a season is running (closing one that is over, and granting the cosmetics a closed season owes);
//   3. rebuild every leaderboard from the XP log (the job leaderboards/reconcile);
//   4. give people the cosmetics they had already earned (the job cosmetics/backfill), page by page until it is done.

export class PostdeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostdeployError'
  }
}

export interface PostdeployDeps {
  /** The raw process environment (only checked, never printed). */
  env: Record<string, string | undefined>
  cache: Cache
  prisma: PrismaClient
  /** Runs a background job to completion, as the queue would. */
  runJob: (name: 'leaderboards/reconcile' | 'cosmetics/backfill', data: unknown) => Promise<unknown>
  now?: () => Date
  /** Where progress goes. */
  say?: (line: string) => void
}

export interface PostdeployOptions {
  /** Check and report, change nothing. */
  dryRun?: boolean
  /** Hold the environment to the production rules even though it does not say it is production (a script run from a laptop against production). */
  production?: boolean
}

export interface StepReport {
  step: 'environment' | 'database' | 'season' | 'leaderboards' | 'cosmetics'
  status: 'done' | 'skipped' | 'planned'
  detail: string
  durationMs: number
}

const present = (value: string | undefined) => typeof value === 'string' && value.trim() !== ''

/**
 * The environment checks, before anything is touched. Throws a PostdeployError that says what is missing, by name and never by value.
 * Returns the warnings of a run that is allowed to go on.
 */
export function checkEnvironment(
  env: Record<string, string | undefined>,
  cache?: Pick<Cache, 'kind'>,
  options: { forceProduction?: boolean } = {}
): { production: boolean; upstash: boolean; warnings: string[] } {
  const production = options.forceProduction === true || requiresProductionConfig(env)
  const missing = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'].filter((name) => !present(env[name]))
  const upstash = missing.length === 0
  const warnings: string[] = []

  if (production) {
    if (!upstash) {
      throw new PostdeployError(
        `REFUSING TO RUN: this is a production environment and ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.\n` +
          'The leaderboards are Redis sorted sets; without Upstash they would live in each web server’s own memory and this script could not fill them.\n' +
          'Set the Upstash variables for this environment and deploy again.'
      )
    }
    if (cache && cache.kind !== 'upstash') {
      throw new PostdeployError('REFUSING TO RUN: production has the Upstash variables set but the app is not using Upstash for its cache (check UPSTASH_REDIS_REST_URL is a valid URL).')
    }
  } else if (!upstash) {
    warnings.push(`${missing.join(' and ')} not set: the cache is in this script’s own memory and would be gone when it exits, so the leaderboards are not rebuilt here (they build themselves on the first read of a running server).`)
  }
  return { production, upstash, warnings }
}

export async function runPostdeploy(deps: PostdeployDeps, options: PostdeployOptions = {}): Promise<StepReport[]> {
  const say = deps.say ?? (() => {})
  const now = deps.now ?? (() => new Date())
  const reports: StepReport[] = []
  const step = async (name: StepReport['step'], run: () => Promise<Pick<StepReport, 'status' | 'detail'>>) => {
    const started = Date.now()
    try {
      const result = await run()
      const report = { step: name, ...result, durationMs: Date.now() - started }
      reports.push(report)
      say(`[${report.status}] ${name}: ${report.detail}`)
    } catch (error) {
      say(`[FAILED] ${name}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  await step('environment', async () => {
    const { production, upstash, warnings } = checkEnvironment(deps.env, deps.cache, { forceProduction: options.production })
    for (const warning of warnings) say(`WARNING: ${warning}`)
    if (upstash) {
      try {
        await deps.cache.ping()
      } catch {
        if (production) throw new PostdeployError('REFUSING TO RUN: Upstash Redis did not answer a ping (the credentials are set but the service is unreachable or rejects them).')
        throw new PostdeployError('Upstash Redis did not answer a ping.')
      }
    }
    return { status: 'done', detail: `${production ? 'production' : 'not production'}, cache: ${upstash ? 'Upstash Redis (answers)' : 'in-process (not shared)'}` }
  })
  const upstash = present(deps.env.UPSTASH_REDIS_REST_URL) && present(deps.env.UPSTASH_REDIS_REST_TOKEN)

  await step('database', async () => {
    await deps.prisma.$queryRaw`SELECT 1`
    return { status: 'done', detail: 'reachable' }
  })

  await step('season', async () => {
    if (options.dryRun) {
      const running = await deps.prisma.season.findFirst({ where: { active: true }, orderBy: { number: 'desc' }, select: { number: true, endsAt: true } })
      const over = running && running.endsAt.getTime() <= now().getTime()
      return { status: 'planned', detail: !running ? 'no season is running: one would be opened' : over ? `Season ${running.number} is over: it would be closed and the next opened` : `Season ${running.number} is running until ${running.endsAt.toISOString()}` }
    }
    const { action, season } = await ensureActiveSeason(deps.prisma, now())
    const verb = action === 'kept' ? 'already running' : action === 'rolled-over' ? 'was over: closed it and opened' : 'none was running: opened'
    // A season that was just closed (or one closed earlier whose rewards failed) is owed its cosmetics.
    const rewards = await grantPendingSeasonRewards(deps.prisma, now())
    const rewarded = rewards.length === 0 ? '' : `; cosmetics granted for ${rewards.map((result) => `Season ${result.seasonNumber}`).join(', ')}`
    return { status: 'done', detail: `${season.name} ${verb} (until ${season.endsAt.toISOString()})${rewarded}` }
  })

  await step('leaderboards', async () => {
    if (!upstash) return { status: 'skipped', detail: 'no shared cache to build them in (see the warning above)' }
    if (options.dryRun) return { status: 'planned', detail: 'would rebuild every current board from the XP log' }
    const result = (await deps.runJob('leaderboards/reconcile', {})) as { periods?: number; boards?: number; members?: number } | undefined
    if (!(await deps.cache.get(BOARDS_READY_KEY))) throw new PostdeployError('the leaderboards were rebuilt but are not marked as built: the cache is not keeping what this script writes')
    return { status: 'done', detail: `rebuilt ${result?.boards ?? '?'} boards over ${result?.periods ?? '?'} periods, ${result?.members ?? '?'} entries` }
  })

  await step('cosmetics', async () => {
    if (options.dryRun) return { status: 'planned', detail: 'would grant the cosmetics people have already earned' }
    let users = 0
    let granted = 0
    let pages = 0
    let after: string | undefined
    do {
      const page = (await deps.runJob('cosmetics/backfill', after ? { after } : {})) as { users: number; granted: number; next: string | null }
      users += page.users
      granted += page.granted
      pages += 1
      after = page.next ?? undefined
    } while (after)
    return { status: 'done', detail: `${users} people checked in ${pages} ${pages === 1 ? 'page' : 'pages'}, ${granted} cosmetics granted` }
  })

  return reports
}
