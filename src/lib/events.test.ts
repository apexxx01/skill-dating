import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import { EventBus, DOMAIN_EVENT_NAMES, EVENT_TRANSACTION_TIMEOUT_MS, type Db } from './events'
import { envelopeForGain } from './rewards-envelope'
import { setErrorReporter } from './log'

function fakeClient(xp = 0) {
  const tx = { user: { findUnique: vi.fn().mockResolvedValue({ xp }) } }
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    user: tx.user,
  }
  return { client: client as unknown as PrismaClient, tx: tx as unknown as Db }
}

const created = { userId: 'u1', projectId: 'p1', projectName: 'Alpha' }

describe('event names', () => {
  it('lists every event the platform stage defines', () => {
    expect([...DOMAIN_EVENT_NAMES].sort()).toEqual(
      [
        'CONNECTION_ACCEPTED',
        'EVIDENCE_ADDED',
        'EVIDENCE_ENDORSED',
        'HACKATHON_JOINED',
        'HACKATHON_WON',
        'MESSAGE_SENT_FIRST_IN_CONNECTION',
        'MILESTONE_COMPLETED',
        'PROJECT_CREATED',
        'PROJECT_SHIPPED',
        'PROJECT_UPDATE_POSTED',
        'TEAM_APPLICATION_ACCEPTED',
        'TEAM_FORMED',
      ].sort()
    )
  })
})

describe('transactional subscribers', () => {
  it('run inside emit, on the same transaction, with the payload', async () => {
    const bus = new EventBus()
    const seen: unknown[] = []
    bus.onTransactional('PROJECT_CREATED', async ({ tx, name, payload }) => {
      seen.push({ tx, name, payload })
    })
    const { client } = fakeClient()
    let insideTx: unknown
    await bus.transact(client, async (tx) => {
      insideTx = tx
      await bus.emit(tx, 'PROJECT_CREATED', created)
      expect(seen).toHaveLength(1)
    })
    expect(seen[0]).toEqual({ tx: insideTx, name: 'PROJECT_CREATED', payload: created })
  })

  it('report whether anything was rewarded', async () => {
    const bus = new EventBus()
    bus.onTransactional('PROJECT_CREATED', async () => ({ rewarded: false }))
    bus.onTransactional('PROJECT_CREATED', async () => ({ rewarded: true }))
    bus.onTransactional('PROJECT_CREATED', async () => undefined)
    const { client } = fakeClient()
    await bus.transact(client, async (tx) => {
      expect(await bus.emit(tx, 'PROJECT_CREATED', created)).toEqual({ rewarded: true })
      expect(await bus.emit(tx, 'PROJECT_SHIPPED', created)).toEqual({ rewarded: false })
    })
  })

  it('run in registration order and only for their own event', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.onTransactional('PROJECT_CREATED', async () => void order.push('first'))
    bus.onTransactional('PROJECT_CREATED', async () => void order.push('second'))
    bus.onTransactional('PROJECT_SHIPPED', async () => void order.push('other'))
    const { client } = fakeClient()
    await bus.transact(client, (tx) => bus.emit(tx, 'PROJECT_CREATED', created))
    expect(order).toEqual(['first', 'second'])
  })

  it('make the transaction fail when one throws, and committed handlers never run', async () => {
    const bus = new EventBus()
    const committed = vi.fn()
    bus.onTransactional('PROJECT_CREATED', async () => {
      throw new Error('reward failed')
    })
    bus.onCommitted('PROJECT_CREATED', committed)
    const { client } = fakeClient()
    await expect(bus.transact(client, (tx) => bus.emit(tx, 'PROJECT_CREATED', created))).rejects.toThrow('reward failed')
    expect(committed).not.toHaveBeenCalled()
  })

  it('can be unsubscribed', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const off = bus.onTransactional('PROJECT_CREATED', handler)
    off()
    const { client } = fakeClient()
    await bus.transact(client, (tx) => bus.emit(tx, 'PROJECT_CREATED', created))
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('committed subscribers', () => {
  it('run after the transaction has committed, not during it', async () => {
    const bus = new EventBus()
    const log: string[] = []
    bus.onCommitted('PROJECT_CREATED', () => void log.push('committed handler'))
    const { client } = fakeClient()
    client.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn({})
      log.push('commit')
      return result
    }) as never
    await bus.transact(client, async (tx) => {
      await bus.emit(tx, 'PROJECT_CREATED', created)
      log.push('end of callback')
    })
    expect(log).toEqual(['end of callback', 'commit', 'committed handler'])
  })

  it('never run when the callback throws after emitting', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.onCommitted('PROJECT_CREATED', handler)
    const { client } = fakeClient()
    await expect(
      bus.transact(client, async (tx) => {
        await bus.emit(tx, 'PROJECT_CREATED', created)
        throw new Error('later step failed')
      })
    ).rejects.toThrow('later step failed')
    expect(handler).not.toHaveBeenCalled()
  })

  it('receive each event in the order it was emitted', async () => {
    const bus = new EventBus()
    const names: string[] = []
    bus.onCommitted('PROJECT_CREATED', ({ name }) => void names.push(name))
    bus.onCommitted('PROJECT_SHIPPED', ({ name }) => void names.push(name))
    const { client } = fakeClient()
    await bus.transact(client, async (tx) => {
      await bus.emit(tx, 'PROJECT_SHIPPED', created)
      await bus.emit(tx, 'PROJECT_CREATED', created)
    })
    expect(names).toEqual(['PROJECT_SHIPPED', 'PROJECT_CREATED'])
  })

  it('cannot fail a request that already succeeded: a throwing handler is logged and the rest still run', async () => {
    const reported = vi.fn()
    setErrorReporter(reported)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const bus = new EventBus()
    const after = vi.fn()
    bus.onCommitted('PROJECT_CREATED', () => {
      throw new Error('analytics down')
    })
    bus.onCommitted('PROJECT_CREATED', after)
    const { client } = fakeClient()
    await expect(bus.transact(client, async (tx) => bus.emit(tx, 'PROJECT_CREATED', created).then(() => 'ok'))).resolves.toMatchObject({ value: 'ok' })
    expect(after).toHaveBeenCalledTimes(1)
    expect(reported).toHaveBeenCalled()
    quiet.mockRestore()
    setErrorReporter(undefined)
  })

  it('run immediately for an event emitted on a bare client', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.onCommitted('PROJECT_CREATED', handler)
    const { client } = fakeClient()
    await bus.emit(client, 'PROJECT_CREATED', created)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('are skipped, not run early, for a transaction the bus did not open', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.onCommitted('PROJECT_CREATED', handler)
    const { tx } = fakeClient()
    await bus.emit(tx, 'PROJECT_CREATED', created)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('afterCommit', () => {
  it('runs once the transaction commits, and not if it rolls back', async () => {
    const bus = new EventBus()
    const callback = vi.fn()
    const { client } = fakeClient()
    await bus.transact(client, async (tx) => void bus.afterCommit(tx, callback))
    expect(callback).toHaveBeenCalledTimes(1)

    const skipped = vi.fn()
    await expect(
      bus.transact(client, async (tx) => {
        bus.afterCommit(tx, skipped)
        throw new Error('rolled back')
      })
    ).rejects.toThrow()
    expect(skipped).not.toHaveBeenCalled()
  })

  it('runs straight away on a bare client', async () => {
    const bus = new EventBus()
    const callback = vi.fn()
    bus.afterCommit(fakeClient().client, callback)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(callback).toHaveBeenCalledTimes(1)
  })
})

describe('rewards in a scope', () => {
  it('merges what a user earned across several awards', async () => {
    const bus = new EventBus()
    const { client } = fakeClient()
    const { scope } = await bus.transact(client, async (tx) => {
      bus.recordReward(tx, 'u1', envelopeForGain(0, 50))
      bus.recordReward(tx, 'u1', envelopeForGain(50, 60, [{ slug: 'a', name: 'A' }]))
      bus.recordReward(tx, 'u2', envelopeForGain(0, 10))
    })
    const reward = await scope.rewardsFor({} as Db, 'u1')
    expect(reward).toMatchObject({ xpGained: 110, totalXp: 110, oldLevel: 1, newLevel: 2, leveledUp: true })
    expect(reward.achievements).toEqual([{ slug: 'a', name: 'A' }])
    expect((await scope.rewardsFor({} as Db, 'u2')).xpGained).toBe(10)
  })

  it('reads the current XP for a user who earned nothing', async () => {
    const bus = new EventBus()
    const { client, tx } = fakeClient(150)
    const { scope } = await bus.transact(client, async () => undefined)
    expect(await scope.rewardsFor(tx, 'u1')).toMatchObject({ xpGained: 0, totalXp: 150, oldLevel: 2, newLevel: 2, leveledUp: false })
  })

  it('ignores a reward recorded outside a transaction', () => {
    const bus = new EventBus()
    expect(() => bus.recordReward(fakeClient().client, 'u1', envelopeForGain(0, 1))).not.toThrow()
  })
})

describe('subscriber loading', () => {
  it('loads the subscribers once, before the first emit', async () => {
    const loadSubscribers = vi.fn().mockResolvedValue(undefined)
    const bus = new EventBus({ loadSubscribers })
    const { client } = fakeClient()
    await bus.transact(client, (tx) => bus.emit(tx, 'PROJECT_CREATED', created))
    await bus.transact(client, (tx) => bus.emit(tx, 'PROJECT_CREATED', created))
    expect(loadSubscribers).toHaveBeenCalledTimes(1)
  })
})

describe('registerOnce', () => {
  it('runs a registration once per name, however often it is asked', () => {
    const bus = new EventBus()
    const register = vi.fn()
    bus.registerOnce('x', register)
    bus.registerOnce('x', register)
    bus.registerOnce('y', register)
    expect(register).toHaveBeenCalledTimes(2)
  })
})

describe('the transaction of an event', () => {
  it('has an explicit 15 second timeout', async () => {
    expect(EVENT_TRANSACTION_TIMEOUT_MS).toBe(15_000)
    const { client } = fakeClient()
    await new EventBus().transact(client, async () => undefined)
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 })
  })

  it('lets a caller choose another limit, and passes the rest of the options through', async () => {
    const { client } = fakeClient()
    await new EventBus().transact(client, async () => undefined, { timeout: 30_000, maxWait: 1000 })
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000, maxWait: 1000 })
  })

  it('is opened with transactWithEvents by every file that emits an event', () => {
    // An event emitted inside a bare prisma.$transaction() would run on Prisma's 5 second
    // default and its committed handlers would be dropped.
    const SRC = path.resolve(__dirname, '..')
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : []
      })
    const emitters = walk(SRC).filter((file) => /\bemit\(\s*tx\b/.test(fs.readFileSync(file, 'utf-8')))
    expect(emitters.length).toBeGreaterThanOrEqual(10)
    const without = emitters.filter((file) => !/transactWithEvents\(/.test(fs.readFileSync(file, 'utf-8'))).map((file) => path.relative(SRC, file))
    expect(without).toEqual([])
  })
})
