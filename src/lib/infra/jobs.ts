import { Inngest } from 'inngest'
import { z } from 'zod'
import { env } from '@/lib/env'
import { log } from '@/lib/log'
import { MemoryJobQueue } from './jobs.memory'

// Background work. Every job is declared once in `jobs` below, with the schema
// of its payload and its handler; producers depend on `JobQueue` only. Inngest
// runs the jobs in production (it calls /api/inngest, which serves the same
// registry); `MemoryJobQueue` (jobs.memory.ts) runs them in-process for tests and
// development without credentials. Swapping provider means writing another
// JobQueue and another way to serve the registry.
//
// Payloads are validated with the job's schema when they are enqueued and again
// when the job runs, so a producer cannot send a shape the handler does not expect.

export interface JobDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Shape of the payload. */
  schema: S
  /** Extra attempts after the first failure. Default 3. */
  retries?: number
  /**
   * A cron expression (UTC), for a job that runs on its own: Inngest triggers it on the schedule
   * as well as on its event. The payload of a scheduled run is empty, so the schema must accept `{}`.
   * The in-process queue never schedules; call it directly (see POST /api/admin/jobs/{name}).
   */
  schedule?: string
  /** The most runs of this job at once (Inngest enforces it; the in-process queue runs one at a time anyway). Unset: no limit of its own. */
  concurrency?: number
  // Method syntax on purpose: it keeps JobDefinition<SpecificSchema> assignable to the registry's JobDefinition.
  handler(context: { data: z.output<S> }): Promise<unknown>
}

export function defineJob<S extends z.ZodTypeAny>(definition: JobDefinition<S>): JobDefinition<S> {
  return definition
}

export type JobRegistry = Record<string, JobDefinition>

// Names are `area/action`, which is also the Inngest event name that triggers the job.
export const jobs = {
  // A round trip through the whole pipeline: enqueue, deliver, run. Use it to
  // check a new environment's Inngest credentials end to end.
  'system/ping': defineJob({
    schema: z.object({ note: z.string().max(200).optional() }),
    handler: async ({ data }) => ({ pong: true, note: data.note ?? null }),
  }),
  // Closes the active season when its time is up, writes the final standings and opens the next
  // season (src/lib/seasons.ts). Hourly: a season may run over its end by up to an hour.
  'seasons/rollover': defineJob({
    schema: z.object({}).default({}),
    schedule: '0 * * * *',
    retries: 2,
    handler: async () => (await import('@/lib/seasons')).runSeasonRollover(),
  }),
  // Recomputes every achievement's rarity: the share of users active in the last 30 days who have it
  // (src/lib/achievement-rarity.ts). Nightly.
  'achievements/rarity': defineJob({
    schema: z.object({}).default({}),
    schedule: '30 3 * * *',
    retries: 2,
    handler: async () => (await import('@/lib/achievement-rarity')).runRarityJob(),
  }),
  // Rebuilds every leaderboard of the current periods from the XP log and swaps each in whole
  // (src/lib/leaderboard-rebuild.ts). Nightly, after every deploy (npm run postdeploy), and once when boards are found never to have been built.
  'leaderboards/reconcile': defineJob({
    schema: z.object({}).default({}),
    schedule: '0 4 * * *',
    retries: 2,
    handler: async () => (await import('@/lib/leaderboard-write')).runReconcileJob(),
  }),
  // Moves one person's entries after they changed where they are or switched leaderboards off or on.
  // `previous` is what they were before, so the boards they have left can be cleared.
  'leaderboards/refresh-user': defineJob({
    schema: z.object({
      userId: z.string().min(1).max(64),
      previous: z
        .object({
          hidden: z.boolean(),
          countryCode: z.string().max(2).nullable(),
          cityKey: z.string().max(100).nullable(),
          campusKey: z.string().max(100).nullable(),
        })
        .nullable()
        .default(null),
    }),
    handler: async ({ data }) => (await import('@/lib/leaderboard-write')).runRefreshUserJob(data.userId, data.previous),
  }),
  // Gives people who earned things before cosmetics existed the cosmetics those earn (src/lib/cosmetics.ts).
  // Run it once after deploying; it is safe to repeat. Pass the `next` it returns as `after` to continue a big run.
  'cosmetics/backfill': defineJob({
    schema: z.object({ after: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(5000).optional() }).default({}),
    retries: 1,
    handler: async ({ data }) => (await import('@/lib/cosmetics')).runCosmeticsBackfill(data),
  }),
  // Gives every person whose daily drop time has passed in their own time zone their drops for the day (src/lib/matching/drops.ts).
  // Hourly, so each lands within the hour after the time they chose; safe to repeat. This job only DISPATCHES: it splits the people who are
  // due into batches per time zone and enqueues a `drops/generate-batch` job for each, so the batches run in parallel. Pass `userIds` to
  // generate for those people only, right away (an operator asking).
  'drops/generate': defineJob({
    schema: z.object({ userIds: z.array(z.string().min(1).max(64)).max(1000).optional() }).default({}),
    schedule: '5 * * * *',
    retries: 1,
    handler: async ({ data }) => (await import('@/lib/matching/drops')).runDropGenerationJob(data),
  }),
  // One batch of the hourly run: generates drops for these people, those of them who are still due (src/lib/matching/drops.ts). Enqueued by
  // `drops/generate`, a few at a time. Safe to repeat: someone who already has today's drops is skipped.
  'drops/generate-batch': defineJob({
    schema: z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(1000) }),
    retries: 2,
    concurrency: 8,
    handler: async ({ data }) => (await import('@/lib/matching/drops')).runDropBatchJob(data),
  }),
  // Once a week brings back, for each person, one previously passed candidate who has grown since (a higher tier or more verified evidence), as an extra drop
  // flagged secondLook (src/lib/matching/second-look.ts). Mondays, after the weekend's passes are in; safe to repeat. Pass `userIds` to run for those people only.
  'drops/second-look': defineJob({
    schema: z.object({ userIds: z.array(z.string().min(1).max(64)).max(1000).optional() }).default({}),
    schedule: '15 7 * * 1',
    retries: 1,
    handler: async ({ data }) => (await import('@/lib/matching/second-look')).runSecondLookJob(data),
  }),
  // Once a local day, from 09:00, tells each person on a plan that does not show who sparked them how many people sparked them (a count, no names), if any did since
  // the last time (src/lib/matching/spark-digest.ts). Hourly; safe to repeat.
  'sparks/digest': defineJob({
    schema: z.object({}).default({}),
    schedule: '35 * * * *',
    retries: 1,
    handler: async () => (await import('@/lib/matching/spark-digest')).runSparkDigestJob(),
  }),
  // Once a local week (from Monday 08:00 in each person's own time zone) gives each person in the romance mode ONE person, chosen for them (src/lib/romance/drops.ts).
  // Hourly, so a drop lands within the hour; this job only DISPATCHES: it splits the people who are due into batches per time zone and enqueues a `romance/drops-batch` job
  // for each. Pass `userIds` to generate for those people only, right away.
  'romance/drops': defineJob({
    schema: z.object({ userIds: z.array(z.string().min(1).max(64)).max(1000).optional() }).default({}),
    schedule: '25 * * * *',
    retries: 1,
    handler: async ({ data }) => (await import('@/lib/romance/drops')).runRomanceDropsJob(data),
  }),
  // One batch of the weekly run: the people of it who are still due. Safe to repeat.
  'romance/drops-batch': defineJob({
    schema: z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(1000) }),
    retries: 2,
    concurrency: 8,
    handler: async ({ data }) => (await import('@/lib/romance/drops')).runRomanceBatchJob(data),
  }),
  // Tells the people who watch a project about a new post on it, in batches of 500 that continue themselves (src/lib/posts/watchers.ts).
  'posts/notify-watchers': defineJob({
    schema: z.object({ postId: z.string().min(1).max(64), after: z.string().min(1).max(64).optional() }),
    retries: 2,
    handler: async ({ data }) => (await import('@/lib/posts/watchers')).runNotifyWatchersJob(data),
  }),
  // Saturday 12:30 UTC, when the last time zone (UTC-12) has left Friday: writes the Ship Day recap of the week, once (src/lib/posts/ship-day.ts).
  'posts/ship-day-recap': defineJob({
    schema: z.object({}).default({}),
    schedule: '30 12 * * 6',
    retries: 2,
    handler: async () => (await import('@/lib/posts/ship-day')).runShipDayRecapJob(),
  }),
  // Removes uploads nobody finished (declared and never confirmed for a day, or rejected), with their objects (src/lib/media-assets.ts). Daily.
  'media/cleanup': defineJob({
    schema: z.object({}).default({}),
    schedule: '50 4 * * *',
    retries: 1,
    handler: async () => (await import('@/lib/media-assets')).runMediaCleanupJob(),
  }),
  // Marks drops nobody answered by the end of their day as EXPIRED.
  'drops/expire': defineJob({
    schema: z.object({}).default({}),
    schedule: '20 * * * *',
    retries: 2,
    handler: async () => (await import('@/lib/matching/drops')).runDropExpiryJob(),
  }),
  // The solo pool's automatic squads (src/lib/squads/pool.ts): round 1 two days before a hackathon's registration deadline, round 2 (the people
  // whose squad did not form, and the leftovers) once round 1 is settled, if there is time. Hourly; with `hackathonId` it runs that hackathon's next
  // round (or `round`) right away. Idempotent: a round runs once per hackathon.
  'squads/auto-form': defineJob({
    schema: z.object({ hackathonId: z.string().min(1).max(64).optional(), round: z.number().int().min(1).max(2).optional() }).default({}),
    schedule: '10 * * * *',
    retries: 2,
    concurrency: 1,
    handler: async ({ data }) => (await import('@/lib/squads/pool')).runAutoFormJob(data),
  }),
  // A squad's slot reopened (someone left or was removed): tells its owner, with up to three people from the pool who want that role.
  'squads/refill-suggestion': defineJob({
    schema: z.object({ teamId: z.string().min(1).max(64), slotId: z.string().min(1).max(64) }),
    retries: 2,
    handler: async ({ data }) => (await import('@/lib/squads/refill')).runRefillSuggestionJob(data),
  }),
  // Hourly upkeep for squads: settles automatic squads whose day is up, expires builder proposals and invitations past their time, and sends the
  // reminders to teamless registrants that are due. Safe to repeat.
  'squads/sweep': defineJob({
    schema: z.object({}).default({}),
    schedule: '40 * * * *',
    retries: 2,
    concurrency: 1,
    handler: async () => (await import('@/lib/squads/pool')).runSquadSweepJob(),
  }),
  // Finds groups of accounts boosting each other in the last 30 days and lowers the weight of what they gave each other (src/lib/integrity/collusion-job.ts).
  // Nightly; safe to repeat (a group is one signal, updated by later runs; a dismissed group is left alone).
  'integrity/collusion': defineJob({
    schema: z.object({}).default({}),
    schedule: '30 2 * * *',
    retries: 1,
    concurrency: 1,
    handler: async () => (await import('@/lib/integrity/collusion-job')).runCollusionJob(),
  }),
  // Recomputes everyone's risk score from their signals, after the collusion run (src/lib/integrity/risk-job.ts). Nightly; safe to repeat.
  'integrity/risk': defineJob({
    schema: z.object({}).default({}),
    schedule: '0 3 * * *',
    retries: 1,
    concurrency: 1,
    handler: async () => (await import('@/lib/integrity/risk-job')).runRiskJob(),
  }),
  // Builds one person's data export into the bucket and tells them it is ready (src/lib/privacy/export.ts). Queued by POST /api/users/me/export.
  'privacy/export': defineJob({
    schema: z.object({ exportId: z.string().min(1).max(64) }),
    retries: 2,
    concurrency: 4,
    handler: async ({ data }) => (await import('@/lib/privacy/export')).runExportJob(data),
  }),
  // Deletes what the retention rules say is old enough (src/lib/privacy/retention.ts): product events, expired drops, resolved reports, export files.
  // Nightly; safe to repeat.
  'privacy/retention': defineJob({
    schema: z.object({}).default({}),
    schedule: '15 5 * * *',
    retries: 1,
    concurrency: 1,
    handler: async () => (await import('@/lib/privacy/retention')).runRetentionJob(),
  }),
  // Scans an uploaded romance photo or avatar again after the scanner failed when it was confirmed (src/lib/media-assets.ts scanAsset).
  'media/scan': defineJob({
    schema: z.object({ assetId: z.string().min(1).max(64) }),
    retries: 5,
    handler: async ({ data }) => (await import('@/lib/media-assets')).runMediaScanJob(data),
  }),
} satisfies JobRegistry

export type Jobs = typeof jobs
export type JobName = keyof Jobs & string
export type JobData<N extends JobName> = z.input<Jobs[N]['schema']>

export interface EnqueueOptions {
  /** Jobs enqueued with the same id are accepted once; later ones are dropped. */
  id?: string
}

export interface JobQueue {
  readonly kind: 'memory' | 'inngest'
  enqueue<N extends JobName>(name: N, data: JobData<N>, options?: EnqueueOptions): Promise<void>
}

export class UnknownJobError extends Error {
  constructor(name: string) {
    super(`Unknown job: ${name}`)
    this.name = 'UnknownJobError'
  }
}

/** Validates a payload against its job's schema. Throws UnknownJobError or a ZodError. */
export function parseJobData<R extends JobRegistry>(registry: R, name: string, data: unknown): unknown {
  const definition = registry[name]
  if (!definition) throw new UnknownJobError(name)
  return definition.schema.parse(data)
}

/** Validates and runs one job. The unit both Inngest and the in-memory queue call. */
export async function runJob<R extends JobRegistry>(registry: R, name: string, data: unknown): Promise<unknown> {
  const definition = registry[name]
  if (!definition) throw new UnknownJobError(name)
  return definition.handler({ data: definition.schema.parse(data) })
}

// --- Inngest ---------------------------------------------------------------

const APP_ID = 'skill-dating'
const DEFAULT_RETRIES = 3
// Inngest types the retry count as a closed range of numbers rather than number.
type InngestRetries = NonNullable<Parameters<Inngest['createFunction']>[0]['retries']>

// Created on first use rather than at import time: `next build` imports the
// route that serves it, and a build must not need credentials.
let inngestClient: Inngest | undefined

/**
 * Whether the Inngest SDK runs in its dev mode. Cloud mode needs the signing key and refuses every request without it, so a process that has no key
 * (development, tests, a preview, the integration suite's production build: all of which run jobs in-process) serves /api/inngest in dev mode. Real
 * production cannot start without the key (src/lib/env.ts), so it is always in cloud mode.
 */
export function inngestDevMode(config: { NODE_ENV: string; INNGEST_SIGNING_KEY?: string }): boolean {
  return config.NODE_ENV !== 'production' || !config.INNGEST_SIGNING_KEY
}

export function getInngest(): Inngest {
  if (!inngestClient) {
    inngestClient = new Inngest({
      id: APP_ID,
      eventKey: env.INNGEST_EVENT_KEY,
      signingKey: env.INNGEST_SIGNING_KEY,
      isDev: inngestDevMode(env),
    })
  }
  return inngestClient
}

/** The slice of the Inngest client the queue uses, so it can be tested without a network. */
export interface EventSender {
  send(payload: { name: string; data: unknown; id?: string }): Promise<unknown>
}

export class InngestJobQueue implements JobQueue {
  readonly kind = 'inngest' as const

  constructor(
    private readonly sender: EventSender,
    private readonly registry: JobRegistry = jobs
  ) {}

  async enqueue<N extends JobName>(name: N, data: JobData<N>, options: EnqueueOptions = {}) {
    const valid = parseJobData(this.registry, name, data)
    await this.sender.send({ name, data: valid, ...(options.id ? { id: options.id } : {}) })
  }
}

/** The registry as Inngest functions, for the /api/inngest route to serve. */
export function inngestFunctions(client: Inngest = getInngest(), registry: JobRegistry = jobs) {
  return Object.entries(registry).map(([name, definition]) =>
    client.createFunction(
      {
        // Function ids are slugs; the event name keeps its slash.
        id: name.replace(/[^a-zA-Z0-9]+/g, '-'),
        triggers: [{ event: name }, ...(definition.schedule ? [{ cron: definition.schedule }] : [])],
        retries: (definition.retries ?? DEFAULT_RETRIES) as InngestRetries,
        ...(definition.concurrency ? { concurrency: definition.concurrency } : {}),
      },
      async ({ event }) => runJob(registry, name, event.data ?? {})
    )
  )
}

// --- Selection -------------------------------------------------------------

export function createJobQueue(): JobQueue {
  if (env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY) {
    return new InngestJobQueue(getInngest() as unknown as EventSender)
  }
  // Without credentials (development, preview deployments, tests) jobs run in
  // this process. They start on their own everywhere but tests, which decide
  // when with drain(); otherwise a preview would queue jobs that never run.
  return new MemoryJobQueue(jobs, {
    autoRun: env.NODE_ENV !== 'test',
    // A job that fails every attempt must not vanish without a trace (Inngest shows its failures; this queue only has the log).
    onOutcome: (outcome) => {
      if (!outcome.ok) log.error('job failed', { job: outcome.name, attempts: outcome.attempts, error: outcome.error })
    },
  })
}

const globalForJobs = globalThis as unknown as { __jobQueue?: JobQueue }

export function getJobQueue(): JobQueue {
  if (!globalForJobs.__jobQueue) globalForJobs.__jobQueue = createJobQueue()
  const queue = globalForJobs.__jobQueue
  // The in-process queue is shared by every route bundle; jobs queued from here run with this module's registry (see QueuedJob.definition in
  // jobs.memory.ts). Checked by shape, not class: another bundle's MemoryJobQueue is another class.
  const shared = queue as Partial<{ withRegistry(registry: JobRegistry): JobQueue }>
  return typeof shared.withRegistry === 'function' ? shared.withRegistry(jobs) : queue
}

/** Replaces the process-wide queue (tests). */
export function setJobQueue(queue: JobQueue | undefined) {
  globalForJobs.__jobQueue = queue
}
