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
        triggers: [{ event: name }],
        retries: (definition.retries ?? DEFAULT_RETRIES) as InngestRetries,
      },
      async ({ event }) => runJob(registry, name, event.data)
    )
  )
}

// --- Selection -------------------------------------------------------------

export function createJobQueue(): JobQueue {
  if (env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY) {
    return new InngestJobQueue(getInngest() as unknown as EventSender)
  }
  // Without credentials (development, tests) jobs run in this process. In
  // development they start on their own; tests decide when with drain().
  return new MemoryJobQueue(jobs, { autoRun: env.NODE_ENV === 'development' })
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
