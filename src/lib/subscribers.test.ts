import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TransactionalContext } from './events'
import type { DomainEventName } from './events'

vi.mock('@/lib/infra/analytics', () => ({ track: vi.fn() }))
const grant = vi.fn()
vi.mock('@/lib/rewards', () => ({ grant: (...args: unknown[]) => grant(...args) }))
const advanceProgress = vi.fn()
vi.mock('@/lib/achievement-progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/achievement-progress')>()),
  advanceProgress: (...args: unknown[]) => advanceProgress(...args),
}))
const lockProgress = vi.fn()
vi.mock('@/lib/metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/metrics')>()),
  lockProgress: (...args: unknown[]) => lockProgress(...args),
}))

import { payForEvent, registerSubscribers } from './subscribers'
import { DOMAIN_EVENT_NAMES, EventBus } from './events'

const DAY = 24 * 60 * 60 * 1000

function applicationContext(applicant: { createdAt: Date; isEmailVerified: boolean } | null): TransactionalContext<DomainEventName> {
  return {
    name: 'TEAM_APPLICATION_ACCEPTED',
    payload: { userId: 'applicant', teamId: 't1', applicationId: 'a1' },
    tx: { user: { findUnique: vi.fn(async () => applicant) } },
  } as unknown as TransactionalContext<DomainEventName>
}

beforeEach(() => {
  grant.mockReset().mockResolvedValue({ granted: true, xp: 50, envelope: {} })
  advanceProgress.mockReset().mockResolvedValue({ unlocked: 0 })
  lockProgress.mockReset().mockResolvedValue(undefined)
})

describe('payForEvent: accepted team applications', () => {
  it('pays XP and counts the progress for an applicant whose account is old enough and verified', async () => {
    const result = await payForEvent(applicationContext({ createdAt: new Date(Date.now() - 30 * DAY), isEmailVerified: true }))
    expect(result).toEqual({ rewarded: true })
    expect(grant).toHaveBeenCalledWith(expect.anything(), 'applicant', 'TEAM_APPLICATION_ACCEPTED', expect.objectContaining({ sourceId: 'a1' }))
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'TEAM_APPLICATION_ACCEPTED', expect.anything(), new Set(['applicant']))
  })

  it('pays nothing and counts nothing for an account younger than seven days', async () => {
    const result = await payForEvent(applicationContext({ createdAt: new Date(Date.now() - 2 * DAY), isEmailVerified: true }))
    expect(result).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
    expect(advanceProgress).not.toHaveBeenCalled()
  })

  it('pays nothing and counts nothing for an old account whose email is not verified', async () => {
    const result = await payForEvent(applicationContext({ createdAt: new Date(Date.now() - 90 * DAY), isEmailVerified: false }))
    expect(result).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
    expect(advanceProgress).not.toHaveBeenCalled()
  })

  it('pays nothing to an applicant that no longer exists', async () => {
    expect(await payForEvent(applicationContext(null))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })
})

describe('payForEvent: progress follows what was paid', () => {
  const connection = (): TransactionalContext<DomainEventName> =>
    ({ name: 'CONNECTION_ACCEPTED', payload: { userId: 'b', otherUserId: 'a', connectionId: 'c1' }, tx: {} }) as unknown as TransactionalContext<DomainEventName>

  it('counts only the people whose award went through, and tells the engine who acted', async () => {
    grant.mockImplementation(async (_tx: unknown, userId: string) => (userId === 'a' ? { granted: false, reason: 'DAILY_CAP', envelope: {} } : { granted: true, xp: 10, envelope: {} }))
    await payForEvent(connection())
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'CONNECTION_ACCEPTED', expect.anything(), new Set(['b']))
    // Recipients are paid in id order; only the accepter (b, the event's userId) is the actor.
    expect(grant.mock.calls.map((call) => [call[1], call[3].actor])).toEqual([['a', false], ['b', true]])
  })

  it('reports a reward when an achievement unlocked even if no XP was paid', async () => {
    grant.mockResolvedValue({ granted: false, reason: 'DAILY_CAP', envelope: {} })
    advanceProgress.mockResolvedValue({ unlocked: 1 })
    expect(await payForEvent(connection())).toEqual({ rewarded: true })
  })

  it('locks everyone the event touches before anything is written', async () => {
    await payForEvent(connection())
    expect(lockProgress).toHaveBeenCalledWith(expect.anything(), ['b', 'a'])
    expect(lockProgress.mock.invocationCallOrder[0]).toBeLessThan(grant.mock.invocationCallOrder[0])
  })

  it('still counts an event that pays no XP of its own', async () => {
    await payForEvent({ name: 'MESSAGE_REPLIED', payload: { userId: 'a', conversationId: 'c', messageId: 'm', repliedToUserId: 'b' }, tx: {} } as unknown as TransactionalContext<DomainEventName>)
    expect(grant).not.toHaveBeenCalled()
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'MESSAGE_REPLIED', expect.anything(), new Set())
  })
})

describe('registerSubscribers', () => {
  it('listens to every event, so every event can count', async () => {
    const bus = new EventBus()
    const seen = new Set<string>()
    const original = bus.onTransactional.bind(bus)
    bus.onTransactional = ((name: DomainEventName, handler: never) => {
      seen.add(name)
      return original(name, handler)
    }) as typeof bus.onTransactional
    registerSubscribers(bus)
    expect([...seen].sort()).toEqual([...DOMAIN_EVENT_NAMES].sort())
  })
})
