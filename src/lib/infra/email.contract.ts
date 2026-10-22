// The shape of an email sender, apart from its implementations so they can import it without importing each other.

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Extra headers (List-Unsubscribe and List-Unsubscribe-Post go here). */
  headers?: Record<string, string>
  /** Labels the provider hands back on its webhook events, so a bounce can be matched to what was sent. */
  tags?: Record<string, string>
  /** The same key sent twice is delivered once (the provider honours it for 24 hours). */
  idempotencyKey?: string
}

export interface EmailSent {
  /** The provider's id for the message; the webhook events refer to it. */
  id: string
}

export interface EmailSender {
  readonly kind: 'memory' | 'resend'
  send(message: EmailMessage): Promise<EmailSent>
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** True when sending the same message again later may work. */
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'EmailSendError'
  }
}
