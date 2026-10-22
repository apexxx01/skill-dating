import { EmailSendError, type EmailMessage, type EmailSender, type EmailSent } from './email.contract'

// In-process `EmailSender`. Keeps every message in `outbox` instead of sending it. A test can make an address fail (`failFor`) to exercise the paths a
// real provider's refusals take.

export interface OutboxMessage extends EmailMessage {
  id: string
  sentAt: Date
}

export class MemoryEmail implements EmailSender {
  readonly kind = 'memory' as const
  readonly outbox: OutboxMessage[] = []
  private readonly failures = new Map<string, { retryable: boolean }>()
  private readonly seenKeys = new Map<string, OutboxMessage>()
  private counter = 0

  /** Makes the next sends to this address fail, as a provider that refuses (or is down) would. */
  failFor(to: string, retryable = false) {
    this.failures.set(to.toLowerCase(), { retryable })
  }

  clearFailures() {
    this.failures.clear()
  }

  async send(message: EmailMessage): Promise<EmailSent> {
    const failure = this.failures.get(message.to.toLowerCase())
    if (failure) throw new EmailSendError('The memory sender was told to fail for this address', failure.retryable)
    if (message.idempotencyKey) {
      const earlier = this.seenKeys.get(message.idempotencyKey)
      if (earlier) return { id: earlier.id }
    }
    const sent: OutboxMessage = { ...message, id: `mem_${++this.counter}_${Date.now().toString(36)}`, sentAt: new Date() }
    this.outbox.push(sent)
    if (message.idempotencyKey) this.seenKeys.set(message.idempotencyKey, sent)
    return { id: sent.id }
  }

  to(address: string): OutboxMessage[] {
    return this.outbox.filter((message) => message.to.toLowerCase() === address.toLowerCase())
  }
}
