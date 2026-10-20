import type { Prisma, PrismaClient } from '@prisma/client'
import type { RewardsEnvelope, Tier } from '@/types/api'
import { log } from '@/lib/log'
import { completeEnvelope, emptyEnvelope, mergeEnvelopes, type EnvelopeDraft } from '@/lib/rewards-envelope'
import { readUserStreak, steadyStatus } from '@/lib/streak-status'

// Typed in-process domain events.
//
// A route that changes something worth reacting to calls emit() INSIDE its
// database transaction. Two kinds of subscriber listen:
//
//  - transactional: runs inside emit(), on the same transaction. This is where
//    anything that must commit or roll back together with the action lives. The
//    rewards engine is one: XP is part of the action, so a failure rolls both back
//    and a rolled-back action never pays out.
//  - committed: runs only after the transaction has committed, and never for one
//    that rolled back. This is for side effects that must not happen for an
//    action that did not happen (analytics). A committed handler that throws is
//    logged and swallowed: it cannot fail a request that already succeeded.
//
// Use transactWithEvents() instead of prisma.$transaction() so the bus knows when
// the transaction ends.

export interface DomainEvents {
  PROJECT_CREATED: { userId: string; projectId: string; projectName: string }
  PROJECT_SHIPPED: { userId: string; projectId: string; projectName: string }
  PROJECT_UPDATE_POSTED: { userId: string; projectId: string; updateId: string }
  MILESTONE_COMPLETED: { userId: string; projectId: string; milestoneId: string }
  HACKATHON_JOINED: { userId: string; hackathonId: string; hackathonName: string }
  /** One event per winning team member. */
  HACKATHON_WON: { userId: string; hackathonId: string; hackathonName: string; hackathonTeamId: string }
  TEAM_FORMED: { userId: string; teamId: string; hackathonId: string; hackathonName: string }
  /**
   * `userId` is the person whose application (or accepted invitation) this is, the one who may be rewarded;
   * `counterpartyId` is the other side: whoever reviewed the application, or sent the invitation.
   */
  TEAM_APPLICATION_ACCEPTED: { userId: string; teamId: string; applicationId: string; counterpartyId: string }
  EVIDENCE_ADDED: { userId: string; evidenceId: string; skillId: string }
  /** `userId` is the owner of the evidence, the one who may be rewarded. */
  EVIDENCE_ENDORSED: { userId: string; endorserId: string; evidenceId: string }
  /** `userId` is the person who accepted; `otherUserId` sent the request. */
  CONNECTION_ACCEPTED: { userId: string; otherUserId: string; connectionId: string }
  /** `userId` is the sender. Emitted once per direct conversation between connected people. */
  MESSAGE_SENT_FIRST_IN_CONNECTION: { userId: string; recipientId: string; conversationId: string; messageId: string }
  /**
   * The streak grew because of an action of the user's own (emitted by the rewards engine, once per local day).
   * `freezeUsedInRun` is whether a freeze was spent anywhere in the current run.
   */
  STREAK_EXTENDED: { userId: string; current: number; longest: number; freezeUsedInRun: boolean }
  /** The user earned from an action of their own after `idleDays` (30 or more) days of earning nothing. */
  USER_COMEBACK: { userId: string; idleDays: number }
  /** `userId` answered a message in a direct conversation that had been waiting on them from `repliedToUserId`. */
  MESSAGE_REPLIED: { userId: string; conversationId: string; messageId: string; repliedToUserId: string }
  /** An achievement was unlocked (emitted by the rewards engine). Cosmetics listen. */
  ACHIEVEMENT_UNLOCKED: { userId: string; slug: string }
  /** The user reached a tier: a new one, or Bronze with their first XP (emitted by the rewards engine). Cosmetics listen. */
  TIER_REACHED: { userId: string; tier: Tier; level: number }
  /**
   * Two people sparked each other. `userId` is the one whose spark completed the pair, `otherUserId` the one who sparked first. Pays NO XP (sparks and
   * matches are never an XP source); it only counts toward the match achievements, for each person whose counterparty is a trusted account.
   */
  MATCH_CREATED: { userId: string; otherUserId: string; matchId: string; connectionType: string; conversationId: string | null }
  /** A person joined a team that has a member they matched with earlier. Pays no XP; counts toward the match-to-team achievement. */
  MATCH_TEAM_FORMED: { userId: string; otherUserId: string; matchId: string; teamId: string }
  /** A post was made on the author's local Ship Day (Friday). Pays no XP; counts once per Ship Day toward the Ship Day quest. */
  POST_SHIP_DAY: { userId: string; postId: string; dateKey: string; kind: 'SHIP' | 'UPDATE' | 'DEVLOG' | 'DEMO' }
  /** `userId` is the author, who may be rewarded; `giverId` gave the Prop. Only a trusted giver pays (src/lib/trust.ts). */
  PROPS_RECEIVED: { userId: string; giverId: string; postId: string; propId: string }
  /** A squad's open slot was filled. `userId` is the team's owner, who may be rewarded; `filledById` joined, the counterparty (src/lib/trust.ts). */
  SQUAD_SLOT_FILLED: { userId: string; teamId: string; slotId: string; filledById: string }
  /** The squad submitted its project to the hackathon: one event per member. */
  SQUAD_SUBMITTED: { userId: string; teamId: string; hackathonId: string; hackathonName: string }
  /** A member who joined someone else's squad stayed until it submitted. `ownerId` runs the squad, the counterparty. */
  SQUAD_JOIN_CONFIRMED: { userId: string; ownerId: string; teamId: string; hackathonId: string; hackathonName: string }
  /** The solo pool put this person on a squad that formed. Pays no XP; counts toward the pool-squad achievement. */
  AUTO_SQUAD_FORMED: { userId: string; teamId: string; hackathonId: string; proposalId: string }
  /** The person's squad shares two or more people with a squad of theirs from an earlier hackathon. Pays no XP; counts toward reunite. */
  SQUAD_REUNITED: { userId: string; teamId: string; hackathonId: string }
}

export type DomainEventName = keyof DomainEvents

export const DOMAIN_EVENT_NAMES = [
  'PROJECT_CREATED',
  'PROJECT_SHIPPED',
  'PROJECT_UPDATE_POSTED',
  'MILESTONE_COMPLETED',
  'HACKATHON_JOINED',
  'HACKATHON_WON',
  'TEAM_FORMED',
  'TEAM_APPLICATION_ACCEPTED',
  'EVIDENCE_ADDED',
  'EVIDENCE_ENDORSED',
  'CONNECTION_ACCEPTED',
  'MESSAGE_SENT_FIRST_IN_CONNECTION',
  'STREAK_EXTENDED',
  'USER_COMEBACK',
  'MESSAGE_REPLIED',
  'ACHIEVEMENT_UNLOCKED',
  'TIER_REACHED',
  'MATCH_CREATED',
  'MATCH_TEAM_FORMED',
  'POST_SHIP_DAY',
  'PROPS_RECEIVED',
  'SQUAD_SLOT_FILLED',
  'SQUAD_SUBMITTED',
  'SQUAD_JOIN_CONFIRMED',
  'AUTO_SQUAD_FORMED',
  'SQUAD_REUNITED',
] as const satisfies readonly DomainEventName[]

export type Db = PrismaClient | Prisma.TransactionClient

/**
 * How long a transaction opened with transact() may run. Prisma's own default is 5
 * seconds; the transaction of a request that emits an event also pays out XP, a
 * level-up and an achievement or two, so it is given a limit of its own instead of
 * inheriting one nobody chose. It is still a ceiling for a handler that is waiting
 * on the database, not room for work: anything slow (email, webhooks, recounts)
 * belongs in a Job (src/lib/infra/jobs.ts), started after the commit.
 */
export const EVENT_TRANSACTION_TIMEOUT_MS = 15_000

export interface EmitResult {
  /** True when a subscriber paid out something (XP or an achievement) because of this event. */
  rewarded: boolean
}

export interface TransactionalContext<N extends DomainEventName> {
  tx: Db
  name: N
  payload: DomainEvents[N]
}

export type TransactionalHandler<N extends DomainEventName> = (context: TransactionalContext<N>) => Promise<EmitResult | void>

export interface CommittedEvent<N extends DomainEventName> {
  name: N
  payload: DomainEvents[N]
}

export type CommittedHandler<N extends DomainEventName> = (event: CommittedEvent<N>) => Promise<void> | void

type AnyCommitted = (event: CommittedEvent<DomainEventName>) => Promise<void> | void
type AnyTransactional = (context: TransactionalContext<DomainEventName>) => Promise<EmitResult | void>

/** What one transaction collected: the events to announce and the rewards earned, per user. */
export class EventScope {
  private readonly events: CommittedEvent<DomainEventName>[] = []
  private readonly callbacks: (() => Promise<void> | void)[] = []
  private readonly envelopes = new Map<string, EnvelopeDraft>()

  addEvent(event: CommittedEvent<DomainEventName>) {
    this.events.push(event)
  }

  addCallback(callback: () => Promise<void> | void) {
    this.callbacks.push(callback)
  }

  /** Adds to what this transaction has earned for the user. */
  addReward(userId: string, envelope: EnvelopeDraft) {
    const existing = this.envelopes.get(userId)
    this.envelopes.set(userId, existing ? mergeEnvelopes(existing, envelope) : envelope)
  }

  /**
   * What the user earned in this transaction, or a "nothing earned" envelope read from their
   * current XP. The streak is whatever the transaction left it at.
   */
  async rewardsFor(db: Db, userId: string): Promise<RewardsEnvelope> {
    const earned = this.envelopes.get(userId)
    if (earned?.streak) return earned as RewardsEnvelope
    const read = await readUserStreak(db, userId)
    const steady = read ? steadyStatus(read) : { current: 0, longest: 0, extended: false, freezeUsed: false }
    return completeEnvelope(earned ?? emptyEnvelope(read?.xp ?? 0), steady)
  }

  /** @internal Called by the bus after the transaction has committed. */
  async flush(committed: (name: DomainEventName) => AnyCommitted[]) {
    for (const event of this.events) {
      for (const handler of committed(event.name)) {
        try {
          await handler(event)
        } catch (error) {
          log.error('committed event handler failed', { event: event.name, error })
        }
      }
    }
    for (const callback of this.callbacks) {
      try {
        await callback()
      } catch (error) {
        log.error('after-commit callback failed', { error })
      }
    }
  }
}

const isClient = (db: Db): db is PrismaClient => '$transaction' in db

export interface EventBusOptions {
  /** Loads the modules that register the subscribers; awaited once before the first emit. */
  loadSubscribers?: () => Promise<unknown>
}

export class EventBus {
  private readonly transactional = new Map<DomainEventName, AnyTransactional[]>()
  private readonly committed = new Map<DomainEventName, AnyCommitted[]>()
  private readonly scopes = new WeakMap<object, EventScope>()
  private ready: Promise<unknown> | undefined
  private readonly registrations = new Set<string>()

  constructor(private readonly options: EventBusOptions = {}) {}

  onTransactional<N extends DomainEventName>(name: N, handler: TransactionalHandler<N>): () => void {
    return this.register(this.transactional, name, handler as unknown as AnyTransactional)
  }

  onCommitted<N extends DomainEventName>(name: N, handler: CommittedHandler<N>): () => void {
    return this.register(this.committed, name, handler as unknown as AnyCommitted)
  }

  private register<H>(map: Map<DomainEventName, H[]>, name: DomainEventName, handler: H): () => void {
    map.set(name, [...(map.get(name) ?? []), handler])
    return () => map.set(name, (map.get(name) ?? []).filter((candidate) => candidate !== handler))
  }

  /** Runs `register` the first time it is called with this name on this bus, and never again. */
  registerOnce(name: string, register: () => void): void {
    if (this.registrations.has(name)) return
    this.registrations.add(name)
    register()
  }

  private async loaded() {
    if (this.options.loadSubscribers) this.ready ??= this.options.loadSubscribers()
    await this.ready
  }

  /** The scope of a transaction opened with transact(), if `db` is one. */
  scopeOf(db: Db): EventScope | undefined {
    return this.scopes.get(db)
  }

  /**
   * Announces an event from inside the transaction `tx`: transactional
   * subscribers run now, committed ones after the transaction commits. Outside a
   * transaction (a bare client) the committed ones run right away; on a
   * transaction not opened by transact() they are dropped, since there is no way
   * to know when it commits.
   */
  async emit<N extends DomainEventName>(tx: Db, name: N, payload: DomainEvents[N]): Promise<EmitResult> {
    await this.loaded()
    log.debug('domain event', { event: name })

    let rewarded = false
    for (const handler of this.transactional.get(name) ?? []) {
      const result = await handler({ tx, name, payload } as TransactionalContext<DomainEventName>)
      if (result?.rewarded) rewarded = true
    }

    const event = { name, payload } as CommittedEvent<DomainEventName>
    const scope = this.scopes.get(tx)
    if (scope) scope.addEvent(event)
    else if (isClient(tx)) {
      const detached = new EventScope()
      detached.addEvent(event)
      await detached.flush((eventName) => this.committed.get(eventName) ?? [])
    } else {
      log.warn('event emitted on a transaction not opened with transactWithEvents; committed handlers skipped', { event: name })
    }
    return { rewarded }
  }

  /** Runs `callback` once the surrounding transaction has committed (immediately on a bare client). */
  afterCommit(db: Db, callback: () => Promise<void> | void): void {
    const scope = this.scopes.get(db)
    if (scope) scope.addCallback(callback)
    else if (isClient(db)) void Promise.resolve().then(callback).catch((error) => log.error('after-commit callback failed', { error }))
    else log.warn('after-commit callback dropped: transaction not opened with transactWithEvents')
  }

  /** Records what a user earned, for the response of the request that opened the transaction. */
  recordReward(db: Db, userId: string, envelope: EnvelopeDraft): void {
    this.scopes.get(db)?.addReward(userId, envelope)
  }

  /**
   * prisma.$transaction() that also tracks events: subscribers see the same
   * transaction, committed subscribers run after it commits (and not at all if it
   * throws), and `scope` says what each user earned. The transaction times out
   * after EVENT_TRANSACTION_TIMEOUT_MS unless `options` say otherwise.
   */
  async transact<T>(
    client: PrismaClient,
    fn: (tx: Prisma.TransactionClient, scope: EventScope) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }
  ): Promise<{ value: T; scope: EventScope }> {
    await this.loaded()
    const scope = new EventScope()
    const value = await client.$transaction(
      async (tx) => {
        this.scopes.set(tx, scope)
        return fn(tx, scope)
      },
      { timeout: EVENT_TRANSACTION_TIMEOUT_MS, ...options }
    )
    await scope.flush((name) => this.committed.get(name) ?? [])
    return { value, scope }
  }
}

// One bus per process. Next can evaluate this module once per route bundle, and
// every copy would otherwise have its own subscribers and its own record of which
// transactions are open: a transaction opened through one copy would be invisible
// to code that reaches the bus through another.
const shared = globalThis as unknown as { __domainEventBus?: EventBus }
export const bus: EventBus = (shared.__domainEventBus ??= new EventBus({ loadSubscribers: () => import('@/lib/subscribers') }))

export const emit = bus.emit.bind(bus)
export const afterCommit = bus.afterCommit.bind(bus)
export const recordReward = bus.recordReward.bind(bus)
export const transactWithEvents = bus.transact.bind(bus)
