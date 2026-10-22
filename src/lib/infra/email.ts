import { env } from '@/lib/env'
import { log } from '@/lib/log'
import { EmailSendError, type EmailMessage, type EmailSender, type EmailSent } from './email.contract'
import { MemoryEmail } from './email.memory'

export { EmailSendError }
export type { EmailMessage, EmailSender, EmailSent }

// Email. Callers depend on `EmailSender`; Resend is the production implementation and `MemoryEmail` (email.memory.ts) keeps what would have been sent, in a
// list, for development and tests. Swapping provider means writing another `EmailSender`.
//
// Nothing here decides WHETHER to send: that is the delivery pipeline (src/lib/notify). This only sends one message, and says whether a failure is worth
// trying again (a rate limit or a provider outage) or final (the address or the message is refused).

export interface ResendConfig {
  apiKey: string
  from: string
  replyTo?: string
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

export class ResendEmail implements EmailSender {
  readonly kind = 'resend' as const

  constructor(
    private readonly config: ResendConfig,
    private readonly fetcher: FetchLike = fetch as unknown as FetchLike
  ) {}

  async send(message: EmailMessage): Promise<EmailSent> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }
    if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
          ...(message.tags ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      // A network failure or a timeout: the message may or may not have gone, the idempotency key makes a second try safe.
      throw new EmailSendError(`Resend could not be reached: ${error instanceof Error ? error.name : 'unknown error'}`, true)
    }
    if (!response.ok) {
      // 429 and 5xx are the provider's trouble and pass; anything else (a bad address, a domain that is not verified, a rejected key) will not change by waiting.
      throw new EmailSendError(`Resend answered ${response.status}`, response.status === 429 || response.status >= 500)
    }
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null
    if (!body || typeof body.id !== 'string') throw new EmailSendError('Resend answered without a message id', true)
    return { id: body.id }
  }
}

// --- Selection -------------------------------------------------------------

export function createEmail(): EmailSender {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) return new ResendEmail({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
  if (env.NODE_ENV === 'production' && !env.INTEGRATION_TEST_SERVER && env.VERCEL_ENV !== 'preview') {
    log.warn('RESEND_API_KEY is not set: email is kept in memory and never leaves the server')
  }
  return new MemoryEmail()
}

const globalForEmail = globalThis as unknown as { __email?: EmailSender }

export function getEmail(): EmailSender {
  if (!globalForEmail.__email) globalForEmail.__email = createEmail()
  return globalForEmail.__email
}

/** Replaces the process-wide sender (tests). */
export function setEmail(sender: EmailSender | undefined) {
  globalForEmail.__email = sender
}
