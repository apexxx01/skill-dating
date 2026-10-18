import { describe, it, expect, vi } from 'vitest'
import { DOMAIN_EVENT_NAMES, type DomainEventName } from './events'
import { accountDistrust, isTrustedCounterparty, MIN_TRUSTED_ACCOUNT_AGE_DAYS, pairDistrust, PEER_PAIRS, peerPairsOf, withheldSubjects, type PeerPair } from './trust'

const now = new Date('2026-06-15T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY)
const established = { createdAt: daysAgo(30), isEmailVerified: true }

describe('accountDistrust', () => {
  it('asks for seven days', () => {
    expect(MIN_TRUSTED_ACCOUNT_AGE_DAYS).toBe(7)
  })

  it('trusts an old enough account with a verified email', () => {
    expect(accountDistrust(established, now)).toBeNull()
  })

  it('trusts on the exact seven day mark and not a millisecond before', () => {
    expect(accountDistrust({ createdAt: daysAgo(7), isEmailVerified: true }, now)).toBeNull()
    expect(accountDistrust({ createdAt: new Date(daysAgo(7).getTime() + 1), isEmailVerified: true }, now)).toBe('account-too-new')
  })

  it('does not trust a new account, however verified', () => {
    expect(accountDistrust({ createdAt: daysAgo(0), isEmailVerified: true }, now)).toBe('account-too-new')
    expect(accountDistrust({ createdAt: daysAgo(6.9), isEmailVerified: true }, now)).toBe('account-too-new')
  })

  it('does not trust an account whose email is not verified, however old', () => {
    expect(accountDistrust({ createdAt: daysAgo(400), isEmailVerified: false }, now)).toBe('email-not-verified')
  })

  it('does not trust an account that does not exist', () => {
    expect(accountDistrust(null, now)).toBe('unknown-account')
    expect(accountDistrust(undefined, now)).toBe('unknown-account')
  })
})

/** A transaction with these accounts and these blocks ([blocker, blocked]). */
function fakeTx(accounts: Record<string, { createdAt: Date; isEmailVerified: boolean }>, blocks: [string, string][] = []) {
  return {
    user: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => accounts[id]).map((id) => ({ id, ...accounts[id] }))) },
    block: {
      findMany: vi.fn(async ({ where }: { where: { OR: { blockerId: string; blockedId: string }[] } }) =>
        blocks.filter(([blockerId, blockedId]) => where.OR.some((clause) => clause.blockerId === blockerId && clause.blockedId === blockedId)).map(([blockerId]) => ({ blockerId }))
      ),
    },
  } as never
}

describe('pairDistrust: the counterparty of a reward', () => {
  const pair = { subjectId: 'me', counterpartyId: 'them' }

  it('lets a trusted counterparty pay, whatever the subject’s own account looks like', async () => {
    const tx = fakeTx({ me: { createdAt: daysAgo(0), isEmailVerified: false }, them: established })
    expect(await pairDistrust(tx, pair, now)).toBeNull()
    expect(await isTrustedCounterparty(tx, pair, now)).toBe(true)
  })

  it('refuses a counterparty that is too new, unverified, or gone', async () => {
    expect(await pairDistrust(fakeTx({ them: { createdAt: daysAgo(2), isEmailVerified: true } }), pair, now)).toBe('account-too-new')
    expect(await pairDistrust(fakeTx({ them: { createdAt: daysAgo(90), isEmailVerified: false } }), pair, now)).toBe('email-not-verified')
    expect(await pairDistrust(fakeTx({}), pair, now)).toBe('unknown-account')
  })

  it('refuses across a block, whichever way it points', async () => {
    const accounts = { me: established, them: established }
    expect(await pairDistrust(fakeTx(accounts, [['me', 'them']]), pair, now)).toBe('blocked')
    expect(await pairDistrust(fakeTx(accounts, [['them', 'me']]), pair, now)).toBe('blocked')
    expect(await pairDistrust(fakeTx(accounts, [['me', 'somebody-else']]), pair, now)).toBeNull()
  })

  it('refuses a person as their own counterparty', async () => {
    expect(await pairDistrust(fakeTx({ me: established }), { subjectId: 'me', counterpartyId: 'me' }, now)).toBe('same-account')
  })

  it('also checks the subject’s account when asked to', async () => {
    const strict = { ...pair, subjectMustBeTrusted: true }
    expect(await pairDistrust(fakeTx({ me: established, them: established }), strict, now)).toBeNull()
    expect(await pairDistrust(fakeTx({ me: { createdAt: daysAgo(1), isEmailVerified: true }, them: established }), strict, now)).toBe('account-too-new')
    expect(await pairDistrust(fakeTx({ me: { createdAt: daysAgo(60), isEmailVerified: false }, them: established }), strict, now)).toBe('email-not-verified')
    expect(await pairDistrust(fakeTx({ them: established }), strict, now)).toBe('unknown-account')
  })

  it('reads the accounts and the blocks, and nothing for a pair that fails the account check first', async () => {
    const tx = fakeTx({ them: { createdAt: daysAgo(1), isEmailVerified: true } }) as unknown as { block: { findMany: ReturnType<typeof vi.fn> } }
    await pairDistrust(tx as never, pair, now)
    expect(tx.block.findMany).not.toHaveBeenCalled()
  })
})

describe('PEER_PAIRS: which events another person can earn you', () => {
  it('names a counterparty for each peer-driven event', () => {
    expect(peerPairsOf('EVIDENCE_ENDORSED', { userId: 'owner', endorserId: 'e', evidenceId: 'x' })).toEqual([{ subjectId: 'owner', counterpartyId: 'e' }])
    expect(peerPairsOf('TEAM_APPLICATION_ACCEPTED', { userId: 'a', teamId: 't', applicationId: 'ap', counterpartyId: 'lead' })).toEqual([{ subjectId: 'a', counterpartyId: 'lead', subjectMustBeTrusted: true }])
    expect(peerPairsOf('CONNECTION_ACCEPTED', { userId: 'acc', otherUserId: 'sender', connectionId: 'c' })).toEqual([
      { subjectId: 'acc', counterpartyId: 'sender' },
      { subjectId: 'sender', counterpartyId: 'acc' },
    ])
    expect(peerPairsOf('MESSAGE_SENT_FIRST_IN_CONNECTION', { userId: 's', recipientId: 'r', conversationId: 'c', messageId: 'm' })).toEqual([{ subjectId: 's', counterpartyId: 'r' }])
    expect(peerPairsOf('MESSAGE_REPLIED', { userId: 'a', conversationId: 'c', messageId: 'm', repliedToUserId: 'b' })).toEqual([{ subjectId: 'a', counterpartyId: 'b' }])
  })

  it('covers exactly the events other people trigger, and none of the ones a person does alone', () => {
    const peer: DomainEventName[] = ['EVIDENCE_ENDORSED', 'TEAM_APPLICATION_ACCEPTED', 'CONNECTION_ACCEPTED', 'MESSAGE_SENT_FIRST_IN_CONNECTION', 'MESSAGE_REPLIED', 'MATCH_CREATED', 'MATCH_TEAM_FORMED', 'PROPS_RECEIVED']
    expect(Object.keys(PEER_PAIRS).sort()).toEqual([...peer].sort())
    for (const name of DOMAIN_EVENT_NAMES.filter((candidate) => !peer.includes(candidate))) expect(PEER_PAIRS[name], name).toBeUndefined()
  })

  it('judges the person paid as well only for an applicant accepted onto a team', () => {
    const samples: Record<string, PeerPair[]> = {
      EVIDENCE_ENDORSED: peerPairsOf('EVIDENCE_ENDORSED', { userId: 'o', endorserId: 'e', evidenceId: 'x' }),
      TEAM_APPLICATION_ACCEPTED: peerPairsOf('TEAM_APPLICATION_ACCEPTED', { userId: 'a', teamId: 't', applicationId: 'ap', counterpartyId: 'l' }),
      CONNECTION_ACCEPTED: peerPairsOf('CONNECTION_ACCEPTED', { userId: 'a', otherUserId: 'b', connectionId: 'c' }),
      MESSAGE_SENT_FIRST_IN_CONNECTION: peerPairsOf('MESSAGE_SENT_FIRST_IN_CONNECTION', { userId: 's', recipientId: 'r', conversationId: 'c', messageId: 'm' }),
      MESSAGE_REPLIED: peerPairsOf('MESSAGE_REPLIED', { userId: 'a', conversationId: 'c', messageId: 'm', repliedToUserId: 'b' }),
    }
    const strict = Object.entries(samples).filter(([, pairs]) => pairs.some((candidate) => candidate.subjectMustBeTrusted))
    expect(strict.map(([name]) => name)).toEqual(['TEAM_APPLICATION_ACCEPTED'])
  })

  it('has no pairs for an event that is not peer-driven', () => {
    expect(peerPairsOf('PROJECT_CREATED', { userId: 'u', projectId: 'p', projectName: 'x' })).toEqual([])
  })
})

describe('withheldSubjects', () => {
  it('names the people whose counterparty is not trusted, and only them', async () => {
    const tx = fakeTx({ acc: established, sender: { createdAt: daysAgo(1), isEmailVerified: true } })
    const pairs = peerPairsOf('CONNECTION_ACCEPTED', { userId: 'acc', otherUserId: 'sender', connectionId: 'c' })
    // The accepter is paid because of the sender, who is new: withheld. The sender is paid because of the accepter, who is fine.
    expect([...(await withheldSubjects(tx, pairs, now))]).toEqual(['acc'])
  })

  it('is empty when every counterparty is trusted, and for no pairs', async () => {
    const tx = fakeTx({ a: established, b: established })
    expect((await withheldSubjects(tx, peerPairsOf('CONNECTION_ACCEPTED', { userId: 'a', otherUserId: 'b', connectionId: 'c' }), now)).size).toBe(0)
    expect((await withheldSubjects(tx, [], now)).size).toBe(0)
  })
})
