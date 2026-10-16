import type { Prisma } from '@prisma/client'
import type { Db, DomainEventName, DomainEvents } from '@/lib/events'
import { blockRelation } from '@/lib/blocks'

// The one rule for rewards that another person can trigger. Somebody else's action (accepting you, endorsing
// you, answering you) is not something you did, so it pays only when that other person is a COUNTERPARTY the
// platform trusts: an account at least seven days old, with a verified email, that has not blocked you and
// that you have not blocked. Two accounts made for the purpose then earn nothing from each other, and a real
// person has to keep one account for a week and verify it before anyone can send XP their way.
//
// Everything peer-driven goes through here (see PEER_PAIRS): endorsements, accepted team applications and
// invitations, accepted connections, first messages and replies. The achievements and quests they count toward
// are only counted for an award that paid, so the gate limits those the same way; replies pay no XP of their
// own and are checked directly.

/** An account younger than this is not a trusted counterparty. */
export const MIN_TRUSTED_ACCOUNT_AGE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export interface AccountFacts {
  createdAt: Date
  isEmailVerified: boolean
}

export type DistrustReason = 'unknown-account' | 'account-too-new' | 'email-not-verified' | 'blocked' | 'same-account'

/** Why an account cannot be a trusted counterparty, or null when it can. Pure: `now` is a parameter so the boundary is testable. */
export function accountDistrust(account: AccountFacts | null | undefined, now: Date = new Date()): Exclude<DistrustReason, 'blocked' | 'same-account'> | null {
  if (!account) return 'unknown-account'
  if (!account.isEmailVerified) return 'email-not-verified'
  if (now.getTime() - account.createdAt.getTime() < MIN_TRUSTED_ACCOUNT_AGE_DAYS * DAY_MS) return 'account-too-new'
  return null
}

/** `subjectId` is the person a reward would be paid to; `counterpartyId` is the person whose action earns it. */
export interface PeerPair {
  subjectId: string
  counterpartyId: string
  /** Also require the subject's own account to pass (an applicant accepted onto a team). */
  subjectMustBeTrusted?: boolean
}

type Tx = Prisma.TransactionClient

/**
 * The first reason a pair is not trusted, or null when the counterparty (and the subject, when asked) may
 * pay out: not the same account, both accounts exist and pass the age and email checks, and neither has blocked
 * the other.
 */
export async function pairDistrust(db: Db, pair: PeerPair, now: Date = new Date()): Promise<DistrustReason | null> {
  if (pair.subjectId === pair.counterpartyId) return 'same-account'
  const tx = db as Tx
  const ids = pair.subjectMustBeTrusted ? [pair.counterpartyId, pair.subjectId] : [pair.counterpartyId]
  const accounts = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true, isEmailVerified: true } })
  const byId = new Map(accounts.map((account) => [account.id, account]))
  for (const id of ids) {
    const reason = accountDistrust(byId.get(id), now)
    if (reason) return reason
  }
  if (await blockRelation(tx, pair.subjectId, pair.counterpartyId)) return 'blocked'
  return null
}

export async function isTrustedCounterparty(db: Db, pair: PeerPair, now: Date = new Date()): Promise<boolean> {
  return (await pairDistrust(db, pair, now)) === null
}

/**
 * Where each peer-driven event names its counterparties: one pair for each person the event could pay because
 * of somebody else. Events that are not here pay for what the user did alone.
 */
export const PEER_PAIRS: { [N in DomainEventName]?: (payload: DomainEvents[N]) => PeerPair[] } = {
  // The owner of the evidence is paid because the endorser vouched for it.
  EVIDENCE_ENDORSED: (p) => [{ subjectId: p.userId, counterpartyId: p.endorserId }],
  // The applicant (or invitee) is paid because the other side accepted; the applicant's own account has to pass too.
  TEAM_APPLICATION_ACCEPTED: (p) => [{ subjectId: p.userId, counterpartyId: p.counterpartyId, subjectMustBeTrusted: true }],
  // Each person is paid for the connection because of the other.
  CONNECTION_ACCEPTED: (p) => [
    { subjectId: p.userId, counterpartyId: p.otherUserId },
    { subjectId: p.otherUserId, counterpartyId: p.userId },
  ],
  // The sender is paid for starting a conversation with the recipient.
  MESSAGE_SENT_FIRST_IN_CONNECTION: (p) => [{ subjectId: p.userId, counterpartyId: p.recipientId }],
  // Pays no XP; it counts toward replies and quests, for the person who answered.
  MESSAGE_REPLIED: (p) => [{ subjectId: p.userId, counterpartyId: p.repliedToUserId }],
}

/** The people an event could pay because of somebody else, by the pairs above. Empty for an event that is not peer-driven. */
export function peerPairsOf<N extends DomainEventName>(name: N, payload: DomainEvents[N]): PeerPair[] {
  const pairs = PEER_PAIRS[name] as ((payload: DomainEvents[N]) => PeerPair[]) | undefined
  return pairs ? pairs(payload) : []
}

/** The subjects among `pairs` whose counterparty is not trusted: the people the event must not pay. */
export async function withheldSubjects(db: Db, pairs: readonly PeerPair[], now: Date = new Date()): Promise<Set<string>> {
  const withheld = new Set<string>()
  for (const pair of pairs) {
    if (!(await isTrustedCounterparty(db, pair, now))) withheld.add(pair.subjectId)
  }
  return withheld
}
