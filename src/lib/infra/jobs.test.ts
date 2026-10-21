import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resetEnvCache } from '@/lib/env'
import {
  InngestJobQueue,
  UnknownJobError,
  createJobQueue,
  defineJob,
  getJobQueue,
  inngestDevMode,
  setJobQueue,
  inngestFunctions,
  jobs,
  runJob,
  type JobRegistry,
} from './jobs'
import { MemoryJobQueue } from './jobs.memory'
import { Inngest } from 'inngest'

describe('registry', () => {
  it('runs a job through its schema and handler', async () => {
    expect(await runJob(jobs, 'system/ping', { note: 'hi' })).toEqual({ pong: true, note: 'hi' })
    expect(await runJob(jobs, 'system/ping', {})).toEqual({ pong: true, note: null })
  })

  it('rejects a payload that does not match the schema', async () => {
    await expect(runJob(jobs, 'system/ping', { note: 42 })).rejects.toThrow()
    await expect(runJob(jobs, 'system/ping', { note: 'x'.repeat(201) })).rejects.toThrow()
  })

  it('rejects a job that is not declared', async () => {
    await expect(runJob(jobs, 'nope/nothing', {})).rejects.toBeInstanceOf(UnknownJobError)
  })
})

describe('MemoryJobQueue', () => {
  it('holds jobs until drained, then runs them in order', async () => {
    const queue = new MemoryJobQueue(jobs)
    await queue.enqueue('system/ping', { note: 'one' })
    await queue.enqueue('system/ping', { note: 'two' })
    expect(queue.waiting).toBe(2)

    const outcomes = await queue.drain()
    expect(outcomes.map((o) => o.result)).toEqual([
      { pong: true, note: 'one' },
      { pong: true, note: 'two' },
    ])
    expect(queue.waiting).toBe(0)
  })

  it('refuses an invalid payload at enqueue time, so it never reaches a worker', async () => {
    const queue = new MemoryJobQueue(jobs)
    await expect(queue.enqueue('system/ping', { note: 42 } as never)).rejects.toThrow()
    expect(queue.waiting).toBe(0)
  })

  it('accepts a repeated id once', async () => {
    const queue = new MemoryJobQueue(jobs)
    await queue.enqueue('system/ping', {}, { id: 'same' })
    await queue.enqueue('system/ping', {}, { id: 'same' })
    await queue.enqueue('system/ping', {}, { id: 'other' })
    expect(queue.accepted).toHaveLength(2)
  })

  describe('retries', () => {
    const attempts = { n: 0 }
    const registry = {
      'test/flaky': defineJob({
        schema: z.object({ failTimes: z.number() }),
        retries: 2,
        handler: async ({ data }) => {
          attempts.n += 1
          if (attempts.n <= data.failTimes) throw new Error(`boom ${attempts.n}`)
          return 'done'
        },
      }),
    } satisfies JobRegistry

    it('retries a failing job and reports success on a later attempt', async () => {
      attempts.n = 0
      const queue = new MemoryJobQueue(registry)
      await queue.enqueue('test/flaky' as never, { failTimes: 2 } as never)
      expect(await queue.drain()).toEqual([{ name: 'test/flaky', ok: true, attempts: 3, result: 'done' }])
    })

    it('gives up after the retries are used and reports the last error', async () => {
      attempts.n = 0
      const queue = new MemoryJobQueue(registry)
      await queue.enqueue('test/flaky' as never, { failTimes: 99 } as never)
      expect(await queue.drain()).toEqual([{ name: 'test/flaky', ok: false, attempts: 3, error: 'boom 3' }])
    })
  })

  it('runs jobs on its own shortly after enqueue when autoRun is on', async () => {
    vi.useFakeTimers()
    try {
      const seen: unknown[] = []
      const queue = new MemoryJobQueue(jobs, { autoRun: true, onOutcome: (o) => seen.push(o.result) })
      await queue.enqueue('system/ping', { note: 'auto' })
      expect(seen).toEqual([])
      await vi.runAllTimersAsync()
      expect(seen).toEqual([{ pong: true, note: 'auto' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('InngestJobQueue', () => {
  it('sends the validated payload as an event named after the job, with the dedupe id', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const queue = new InngestJobQueue({ send })
    await queue.enqueue('system/ping', { note: 'x' }, { id: 'abc' })
    expect(send).toHaveBeenCalledWith({ name: 'system/ping', data: { note: 'x' }, id: 'abc' })
  })

  it('omits the id when there is none, and strips fields the schema does not know', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    await new InngestJobQueue({ send }).enqueue('system/ping', { note: 'x', extra: 'y' } as never)
    expect(send).toHaveBeenCalledWith({ name: 'system/ping', data: { note: 'x' } })
  })

  it('sends nothing for an invalid payload', async () => {
    const send = vi.fn()
    await expect(new InngestJobQueue({ send }).enqueue('system/ping', { note: 1 } as never)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('lets a send failure reach the caller', async () => {
    const send = vi.fn().mockRejectedValue(new Error('inngest down'))
    await expect(new InngestJobQueue({ send }).enqueue('system/ping', {})).rejects.toThrow('inngest down')
  })
})

describe('inngestFunctions', () => {
  it('declares one function per job, triggered by the job name', () => {
    const client = new Inngest({ id: 'test', isDev: true })
    const functions = inngestFunctions(client)
    expect(functions).toHaveLength(Object.keys(jobs).length)
    const config = functions[0].opts as { id: string; triggers: { event: string }[] }
    expect(config.id).toBe('system-ping')
    expect(config.triggers).toEqual([{ event: 'system/ping' }])
  })
})

describe('scheduled jobs', () => {
  const registry = {
    'area/tick': defineJob({ schema: z.object({}).default({}), schedule: '0 3 * * *', handler: async () => ({ ran: true }) }),
    'area/manual': defineJob({ schema: z.object({ id: z.string() }), handler: async () => ({}) }),
  }

  it('triggers a scheduled job by its cron as well as by its event, and an unscheduled one by its event only', () => {
    const client = new Inngest({ id: 'test', isDev: true })
    const [tick, manual] = inngestFunctions(client, registry).map((fn) => fn.opts as { triggers: object[] })
    expect(tick.triggers).toEqual([{ event: 'area/tick' }, { cron: '0 3 * * *' }])
    expect(manual.triggers).toEqual([{ event: 'area/manual' }])
  })

  it('runs a scheduled job with an empty payload', async () => {
    expect(await runJob(registry, 'area/tick', {})).toEqual({ ran: true })
    expect(await runJob(registry, 'area/tick', undefined)).toEqual({ ran: true })
  })
})

describe('createJobQueue', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    resetEnvCache()
  })

  it('uses the in-process queue without Inngest credentials', () => {
    delete process.env.INNGEST_EVENT_KEY
    delete process.env.INNGEST_SIGNING_KEY
    resetEnvCache()
    expect(createJobQueue().kind).toBe('memory')
  })

  it('runs in-process jobs on their own except under test, so a preview does not queue them forever', async () => {
    delete process.env.INNGEST_EVENT_KEY
    delete process.env.INNGEST_SIGNING_KEY
    for (const [nodeEnv, autoRuns] of [['production', true], ['development', true], ['test', false]] as const) {
      Object.assign(process.env, { NODE_ENV: nodeEnv, VERCEL_ENV: 'preview' }) // a production process without the services is a preview
      resetEnvCache()
      const queue = createJobQueue() as MemoryJobQueue
      vi.useFakeTimers()
      try {
        await queue.enqueue('system/ping', { note: 'x' })
        await vi.runAllTimersAsync()
        expect(queue.waiting, nodeEnv).toBe(autoRuns ? 0 : 1)
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('uses Inngest when both credentials are set', () => {
    process.env.INNGEST_EVENT_KEY = 'event-key'
    process.env.INNGEST_SIGNING_KEY = 'signing-key'
    resetEnvCache()
    expect(createJobQueue().kind).toBe('inngest')
  })
})

// In a Next server every route bundle has its own copy of the job registry, and the in-process queue is shared by all of them. A job must run with the
// registry of the code that queued it: run with the registry of whichever bundle created the queue, a handler's `import()` can point at a bundle that
// does not have its module, and every attempt fails ("Cannot read properties of undefined (reading 'call')"). This is what made the squad refill
// suggestion vanish in long dev-server runs.
describe('a queue shared by several bundles', () => {
  const echo = (tag: string): JobRegistry => ({ 'system/ping': defineJob({ schema: z.object({ note: z.string().optional() }), handler: async () => tag }) })

  it('runs each job with the registry it was queued with, not the one the queue was made with', async () => {
    const creator = echo('creator bundle')
    const queue = new MemoryJobQueue(creator)
    await queue.withRegistry(echo('queuing bundle')).enqueue('system/ping', {})
    await queue.enqueue('system/ping', {})
    expect((await queue.drain()).map((outcome) => outcome.result)).toEqual(['queuing bundle', 'creator bundle'])
  })

  it('validates against the queuing registry and keeps the shared state (dedupe ids, order)', async () => {
    const queue = new MemoryJobQueue(echo('creator'))
    const view = queue.withRegistry(echo('view'))
    await view.enqueue('system/ping', {}, { id: 'once' })
    await view.enqueue('system/ping', {}, { id: 'once' })
    expect(queue.waiting).toBe(1)
    await expect(view.enqueue('system/ping', { note: 42 } as never)).rejects.toThrow()
  })

  it('gives every caller of getJobQueue a view that queues with its own registry', async () => {
    const shared = new MemoryJobQueue(echo('another bundle'))
    setJobQueue(shared)
    try {
      await getJobQueue().enqueue('system/ping', { note: 'from here' })
      expect((await shared.drain())[0].result).toEqual({ pong: true, note: 'from here' })
    } finally {
      setJobQueue(undefined)
    }
  })

  it('reports a job that fails every attempt, so it is never lost silently', async () => {
    const outcomes: unknown[] = []
    const failing: JobRegistry = { 'system/ping': defineJob({ schema: z.object({}).passthrough(), retries: 1, handler: async () => { throw new Error("Cannot read properties of undefined (reading 'call')") } }) }
    const queue = new MemoryJobQueue(failing, { onOutcome: (outcome) => outcomes.push(outcome) })
    await queue.enqueue('system/ping', {})
    await queue.drain()
    expect(outcomes).toEqual([{ name: 'system/ping', ok: false, attempts: 2, error: "Cannot read properties of undefined (reading 'call')" }])
  })
})

describe('inngestDevMode', () => {
  it('uses cloud mode only where it can work: production with a signing key', () => {
    expect(inngestDevMode({ NODE_ENV: 'production', INNGEST_SIGNING_KEY: 'signkey-prod-x' })).toBe(false)
    expect(inngestDevMode({ NODE_ENV: 'production' })).toBe(true)
    expect(inngestDevMode({ NODE_ENV: 'development', INNGEST_SIGNING_KEY: 'signkey-x' })).toBe(true)
    expect(inngestDevMode({ NODE_ENV: 'test' })).toBe(true)
  })
})
