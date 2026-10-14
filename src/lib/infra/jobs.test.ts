import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resetEnvCache } from '@/lib/env'
import {
  InngestJobQueue,
  UnknownJobError,
  createJobQueue,
  defineJob,
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
