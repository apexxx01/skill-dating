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

const endorsementRewardAllowed = vi.fn()
vi.mock('@/lib/skill-evidence', () => ({ endorsementRewardAllowed: (...args: unknown[]) => endorsementRewardAllowed(...args) }))

import { payForEvent, registerSubscribers } from './subscribers'
import { DOMAIN_EVENT_NAMES, EventBus } from './events'

const DAY = 24 * 60 * 60 * 1000
type Account = { createdAt: Date; isEmailVerified: boolean }
const established: Account = { createdAt: new Date(Date.now() - 30 * DAY), isEmailVerified: true }
const tooNew: Account = { createdAt: new Date(Date.now() - 2 * DAY), isEmailVerified: true }
const unverified: Account = { createdAt: new Date(Date.now() - 90 * DAY), isEmailVerified: false }

/** A transaction with these accounts and these blocks ([blocker, blocked]). */
function tx(accounts: Record<string, Account>, blocks: [string, string][] = []) {
  return {
    user: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => accounts[id]).map((id) => ({ id, ...accounts[id] }))) },
    block: {
      findMany: vi.fn(async ({ where }: { where: { OR: { blockerId: string; blockedId: string }[] } }) =>
        blocks.filter(([blockerId, blockedId]) => where.OR.some((clause) => clause.blockerId === blockerId && clause.blockedId === blockedId)).map(([blockerId]) => ({ blockerId }))
      ),
    },
  }
}
const event = (name: DomainEventName, payload: object, transaction: ReturnType<typeof tx>) => ({ name, payload, tx: transaction }) as unknown as TransactionalContext<DomainEventName>

beforeEach(() => {
  grant.mockReset().mockResolvedValue({ granted: true, xp: 50, envelope: {} })
  advanceProgress.mockReset().mockResolvedValue({ unlocked: 0 })
  lockProgress.mockReset().mockResolvedValue(undefined)
  endorsementRewardAllowed.mockReset().mockResolvedValue(true)
})

// Every reward another person can trigger is paid only when that person is a trusted counterparty (src/lib/trust.ts):
// an account a week old with a verified email, not blocked either way. These run each path through the real gate.
describe('payForEvent: endorsements', () => {
  const endorsed = (transaction: ReturnType<typeof tx>) => event('EVIDENCE_ENDORSED', { userId: 'owner', endorserId: 'endorser', evidenceId: 'e1' }, transaction)

  it('pays the owner, and counts it, when the endorser is a trusted counterparty', async () => {
    expect(await payForEvent(endorsed(tx({ owner: tooNew, endorser: established })))).toEqual({ rewarded: true })
    expect(grant).toHaveBeenCalledWith(expect.anything(), 'owner', 'EVIDENCE_ENDORSED', expect.objectContaining({ sourceId: 'e1:endorser' }))
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'EVIDENCE_ENDORSED', expect.anything(), new Set(['owner']))
  })

  for (const [what, endorser] of [['an account under seven days old', tooNew], ['an account without a verified email', unverified]] as const) {
    it(`pays nothing, XP or progress, when the endorser is ${what}`, async () => {
      expect(await payForEvent(endorsed(tx({ owner: established, endorser })))).toEqual({ rewarded: false })
      expect(grant).not.toHaveBeenCalled()
      expect(advanceProgress).not.toHaveBeenCalled()
    })
  }

  it('pays nothing across a block, in either direction', async () => {
    for (const block of [['owner', 'endorser'], ['endorser', 'owner']] as [string, string][]) {
      expect(await payForEvent(endorsed(tx({ owner: established, endorser: established }, [block])))).toEqual({ rewarded: false })
    }
    expect(grant).not.toHaveBeenCalled()
    expect(advanceProgress).not.toHaveBeenCalled()
  })

  it('pays nothing when the endorser is the owner, or does not exist', async () => {
    expect(await payForEvent(event('EVIDENCE_ENDORSED', { userId: 'owner', endorserId: 'owner', evidenceId: 'e1' }, tx({ owner: established })))).toEqual({ rewarded: false })
    expect(await payForEvent(endorsed(tx({ owner: established })))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })

  it('still applies the endorsement rules after the gate', async () => {
    endorsementRewardAllowed.mockResolvedValue(false)
    expect(await payForEvent(endorsed(tx({ owner: established, endorser: established })))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })
})

describe('payForEvent: accepted team applications and invitations', () => {
  const accepted = (transaction: ReturnType<typeof tx>) => event('TEAM_APPLICATION_ACCEPTED', { userId: 'applicant', teamId: 't1', applicationId: 'a1', counterpartyId: 'lead' }, transaction)

  it('pays XP and counts the progress when both the applicant and the other side are trusted', async () => {
    expect(await payForEvent(accepted(tx({ applicant: established, lead: established })))).toEqual({ rewarded: true })
    expect(grant).toHaveBeenCalledWith(expect.anything(), 'applicant', 'TEAM_APPLICATION_ACCEPTED', expect.objectContaining({ sourceId: 'a1' }))
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'TEAM_APPLICATION_ACCEPTED', expect.anything(), new Set(['applicant']))
  })

  for (const [what, accounts] of [
    ['an applicant under seven days old', { applicant: tooNew, lead: established }],
    ['an applicant whose email is not verified', { applicant: unverified, lead: established }],
    ['a reviewer under seven days old', { applicant: established, lead: tooNew }],
    ['a reviewer whose email is not verified', { applicant: established, lead: unverified }],
    ['an applicant that no longer exists', { lead: established }],
    ['a reviewer that no longer exists', { applicant: established }],
  ] as const) {
    it(`pays nothing and counts nothing for ${what}`, async () => {
      expect(await payForEvent(accepted(tx(accounts)))).toEqual({ rewarded: false })
      expect(grant).not.toHaveBeenCalled()
      expect(advanceProgress).not.toHaveBeenCalled()
    })
  }

  it('pays nothing across a block', async () => {
    expect(await payForEvent(accepted(tx({ applicant: established, lead: established }, [['lead', 'applicant']])))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })
})

describe('payForEvent: accepted connections', () => {
  const connection = (transaction: ReturnType<typeof tx>) => event('CONNECTION_ACCEPTED', { userId: 'b', otherUserId: 'a', connectionId: 'c1' }, transaction)

  it('pays both people when each is a trusted counterparty to the other', async () => {
    await payForEvent(connection(tx({ a: established, b: established })))
    expect(grant.mock.calls.map((call) => call[1])).toEqual(['a', 'b'])
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'CONNECTION_ACCEPTED', expect.anything(), new Set(['a', 'b']))
  })

  it('pays only the person whose counterparty is trusted: a new account earns the old one nothing, and the old one earns it plenty', async () => {
    // b (the accepter) is paid because of a. a is paid because of b.
    const result = await payForEvent(connection(tx({ a: established, b: tooNew })))
    expect(result).toEqual({ rewarded: true })
    expect(grant.mock.calls.map((call) => call[1])).toEqual(['b'])
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'CONNECTION_ACCEPTED', expect.anything(), new Set(['b']))
  })

  it('pays neither when neither is trusted, and counts nothing', async () => {
    expect(await payForEvent(connection(tx({ a: tooNew, b: unverified })))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
    expect(advanceProgress).not.toHaveBeenCalled()
  })

  it('pays neither across a block', async () => {
    expect(await payForEvent(connection(tx({ a: established, b: established }, [['a', 'b']])))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })

  it('counts only the people whose award went through, and tells the engine who acted', async () => {
    grant.mockImplementation(async (_tx: unknown, userId: string) => (userId === 'a' ? { granted: false, reason: 'DAILY_CAP', envelope: {} } : { granted: true, xp: 10, envelope: {} }))
    await payForEvent(connection(tx({ a: established, b: established })))
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'CONNECTION_ACCEPTED', expect.anything(), new Set(['b']))
    // Recipients are paid in id order; only the accepter (b, the event's userId) is the actor.
    expect(grant.mock.calls.map((call) => [call[1], call[3].actor])).toEqual([['a', false], ['b', true]])
  })
})

describe('payForEvent: first messages', () => {
  const first = (transaction: ReturnType<typeof tx>) => event('MESSAGE_SENT_FIRST_IN_CONNECTION', { userId: 'sender', recipientId: 'recipient', conversationId: 'c1', messageId: 'm1' }, transaction)

  it('pays the sender when the recipient is a trusted counterparty', async () => {
    expect(await payForEvent(first(tx({ sender: tooNew, recipient: established })))).toEqual({ rewarded: true })
    expect(grant).toHaveBeenCalledWith(expect.anything(), 'sender', 'MESSAGE_SENT_FIRST_IN_CONNECTION', expect.objectContaining({ sourceId: 'c1' }))
  })

  for (const [what, recipient] of [['under seven days old', tooNew], ['without a verified email', unverified]] as const) {
    it(`pays nothing and counts nothing when the recipient is ${what}`, async () => {
      expect(await payForEvent(first(tx({ sender: established, recipient })))).toEqual({ rewarded: false })
      expect(grant).not.toHaveBeenCalled()
      expect(advanceProgress).not.toHaveBeenCalled()
    })
  }

  it('pays nothing across a block', async () => {
    expect(await payForEvent(first(tx({ sender: established, recipient: established }, [['recipient', 'sender']])))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })
})

describe('payForEvent: replies, which pay no XP but count toward achievements and quests', () => {
  const reply = (transaction: ReturnType<typeof tx>) => event('MESSAGE_REPLIED', { userId: 'replier', conversationId: 'c', messageId: 'm', repliedToUserId: 'waiting' }, transaction)

  it('counts a reply to a trusted counterparty', async () => {
    await payForEvent(reply(tx({ replier: tooNew, waiting: established })))
    expect(grant).not.toHaveBeenCalled()
    // A reply pays no XP, so the person it counts for (the one who answered) is the one "paid".
    expect(advanceProgress).toHaveBeenCalledWith(expect.anything(), 'MESSAGE_REPLIED', expect.anything(), new Set(['replier']))
  })

  for (const [what, waiting] of [['under seven days old', tooNew], ['without a verified email', unverified]] as const) {
    it(`counts nothing when the person who was waiting is ${what}`, async () => {
      expect(await payForEvent(reply(tx({ replier: established, waiting })))).toEqual({ rewarded: false })
      expect(advanceProgress).not.toHaveBeenCalled()
    })
  }

  it('counts nothing across a block', async () => {
    expect(await payForEvent(reply(tx({ replier: established, waiting: established }, [['waiting', 'replier']])))).toEqual({ rewarded: false })
    expect(advanceProgress).not.toHaveBeenCalled()
  })
})

describe('payForEvent: what a person does alone is not gated', () => {
  it('pays and counts a project without looking at anyone else', async () => {
    const transaction = tx({})
    expect(await payForEvent(event('PROJECT_CREATED', { userId: 'u', projectId: 'p', projectName: 'x' }, transaction))).toEqual({ rewarded: true })
    expect(transaction.user.findMany).not.toHaveBeenCalled()
    expect(transaction.block.findMany).not.toHaveBeenCalled()
  })
})

describe('payForEvent: progress follows what was paid', () => {
  const connection = () => event('CONNECTION_ACCEPTED', { userId: 'b', otherUserId: 'a', connectionId: 'c1' }, tx({ a: established, b: established }))

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
