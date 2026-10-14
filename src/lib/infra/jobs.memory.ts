import type { EnqueueOptions, JobData, JobName, JobQueue, JobRegistry } from './jobs'

// In-process `JobQueue`. Jobs wait in a list until `drain()` runs them (tests),
// or run on their own shortly after being enqueued (`autoRun`, development).
// It validates payloads, drops repeated ids and retries failures like the real
// queue does, but it is not durable: a restart loses whatever was waiting.

export interface QueuedJob {
  name: string
  data: unknown
  id?: string
}

export interface JobOutcome {
  name: string
  ok: boolean
  attempts: number
  result?: unknown
  error?: string
}

export interface MemoryJobQueueOptions {
  autoRun?: boolean
  /** Called with each outcome, for logging in development. */
  onOutcome?: (outcome: JobOutcome) => void
}

export class MemoryJobQueue implements JobQueue {
  readonly kind = 'memory' as const
  /** Everything accepted so far, in order. */
  readonly accepted: QueuedJob[] = []
  private pending: QueuedJob[] = []
  private readonly seenIds = new Set<string>()
  private scheduled = false

  constructor(
    private readonly registry: JobRegistry,
    private readonly options: MemoryJobQueueOptions = {}
  ) {}

  async enqueue<N extends JobName>(name: N, data: JobData<N>, options: EnqueueOptions = {}) {
    const definition = this.registry[name]
    if (!definition) throw new Error(`Unknown job: ${name}`)
    const valid = definition.schema.parse(data)

    if (options.id) {
      if (this.seenIds.has(options.id)) return
      this.seenIds.add(options.id)
    }
    const job: QueuedJob = { name, data: valid, ...(options.id ? { id: options.id } : {}) }
    this.accepted.push(job)
    this.pending.push(job)
    if (this.options.autoRun) this.schedule()
  }

  get waiting(): number {
    return this.pending.length
  }

  /** Runs everything waiting (including jobs enqueued meanwhile) and reports each outcome. */
  async drain(): Promise<JobOutcome[]> {
    const outcomes: JobOutcome[] = []
    while (this.pending.length > 0) {
      const job = this.pending.shift()!
      const outcome = await this.run(job)
      outcomes.push(outcome)
      this.options.onOutcome?.(outcome)
    }
    return outcomes
  }

  private async run(job: QueuedJob): Promise<JobOutcome> {
    const definition = this.registry[job.name]
    const maxAttempts = 1 + (definition.retries ?? 3)
    let lastError = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await definition.handler({ data: definition.schema.parse(job.data) })
        return { name: job.name, ok: true, attempts: attempt, result }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    return { name: job.name, ok: false, attempts: maxAttempts, error: lastError }
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(() => {
      this.scheduled = false
      void this.drain()
    }, 0)
  }
}
