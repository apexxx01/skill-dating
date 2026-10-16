import { Inngest } from 'inngest'
import { z } from 'zod'
import { env } from '@/lib/env'
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

export function getInngest(): Inngest {
  if (!inngestClient) {
    inngestClient = new Inngest({
      id: APP_ID,
      eventKey: env.INNGEST_EVENT_KEY,
      signingKey: env.INNGEST_SIGNING_KEY,
      isDev: env.NODE_ENV !== 'production',
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
  return new MemoryJobQueue(jobs, { autoRun: env.NODE_ENV !== 'test' })
}

const globalForJobs = globalThis as unknown as { __jobQueue?: JobQueue }

export function getJobQueue(): JobQueue {
  if (!globalForJobs.__jobQueue) globalForJobs.__jobQueue = createJobQueue()
  return globalForJobs.__jobQueue
}

/** Replaces the process-wide queue (tests). */
export function setJobQueue(queue: JobQueue | undefined) {
  globalForJobs.__jobQueue = queue
}
