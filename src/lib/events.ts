import type { Prisma, PrismaClient } from '@prisma/client'
import type { RewardsEnvelope } from '@/types/api'
import { log } from '@/lib/log'
import { emptyEnvelope, mergeEnvelopes } from '@/lib/rewards-envelope'

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
  /** `userId` is the person whose application was accepted. */
  TEAM_APPLICATION_ACCEPTED: { userId: string; teamId: string; applicationId: string }
  EVIDENCE_ADDED: { userId: string; evidenceId: string; skillId: string }
  /** `userId` is the owner of the evidence, the one who may be rewarded. */
  EVIDENCE_ENDORSED: { userId: string; endorserId: string; evidenceId: string }
  /** `userId` is the person who accepted; `otherUserId` sent the request. */
  CONNECTION_ACCEPTED: { userId: string; otherUserId: string; connectionId: string }
  /** `userId` is the sender. Emitted once per direct conversation between connected people. */
  MESSAGE_SENT_FIRST_IN_CONNECTION: { userId: string; recipientId: string; conversationId: string; messageId: string }
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
] as const satisfies readonly DomainEventName[]

export type Db = PrismaClient | Prisma.TransactionClient

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
  private readonly envelopes = new Map<string, RewardsEnvelope>()

  addEvent(event: CommittedEvent<DomainEventName>) {
    this.events.push(event)
  }

  addCallback(callback: () => Promise<void> | void) {
    this.callbacks.push(callback)
  }

  /** Adds to what this transaction has earned for the user. */
  addReward(userId: string, envelope: RewardsEnvelope) {
    const existing = this.envelopes.get(userId)
    this.envelopes.set(userId, existing ? mergeEnvelopes(existing, envelope) : envelope)
  }

  /** What the user earned in this transaction, or a "nothing earned" envelope read from their current XP. */
  async rewardsFor(db: Db, userId: string): Promise<RewardsEnvelope> {
    const earned = this.envelopes.get(userId)
    if (earned) return earned
    const row = await db.user.findUnique({ where: { id: userId }, select: { xp: true } })
    return emptyEnvelope(row?.xp ?? 0)
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
  recordReward(db: Db, userId: string, envelope: RewardsEnvelope): void {
    this.scopes.get(db)?.addReward(userId, envelope)
  }

  /**
   * prisma.$transaction() that also tracks events: subscribers see the same
   * transaction, committed subscribers run after it commits (and not at all if it
   * throws), and `scope` says what each user earned.
   */
  async transact<T>(
    client: PrismaClient,
    fn: (tx: Prisma.TransactionClient, scope: EventScope) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }
  ): Promise<{ value: T; scope: EventScope }> {
    await this.loaded()
    const scope = new EventScope()
    const value = await client.$transaction(async (tx) => {
      this.scopes.set(tx, scope)
      return fn(tx, scope)
    }, options)
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
