import type { PrismaClient } from '@prisma/client'
import { suppressAddress } from './settings'

// What the email provider tells us after it took a message (POST /api/webhooks/email, signed by the provider): the message bounced, or the person marked it as
// spam. Either way the address is suppressed and mail to it stops (settings.ts isSuppressed, used by the pipeline for every kind, account notices included).
// A transient bounce (a full mailbox, a server down for a moment) is not a reason to stop: the provider retries it itself.

export interface EmailEvent {
  type: string
  data?: {
    email_id?: unknown
    to?: unknown
    bounce?: { type?: unknown } | null
  } | null
}

export type EmailEventResult = { handled: 'BOUNCE' | 'COMPLAINT'; addresses: number } | { handled: 'IGNORED'; reason: string }

const addressesOf = (to: unknown): string[] => (Array.isArray(to) ? to.filter((value): value is string => typeof value === 'string' && value.includes('@') && value.length <= 320) : [])

/** Whether a bounce is final. Resend says Permanent, Transient or Undetermined; only a transient one is worth waiting out. */
export function isPermanentBounce(bounce: { type?: unknown } | null | undefined): boolean {
  return typeof bounce?.type !== 'string' || bounce.type.toLowerCase() !== 'transient'
}

export async function processEmailEvent(db: PrismaClient, event: EmailEvent): Promise<EmailEventResult> {
  const complaint = event.type === 'email.complained'
  const bounce = event.type === 'email.bounced'
  if (!complaint && !bounce) return { handled: 'IGNORED', reason: 'event type not handled' }
  if (bounce && !isPermanentBounce(event.data?.bounce)) return { handled: 'IGNORED', reason: 'transient bounce' }

  const reason = complaint ? 'COMPLAINT' : 'BOUNCE'
  const addresses = addressesOf(event.data?.to)
  for (const address of addresses) await suppressAddress(db, address, reason)

  // The delivery it was about, so the numbers (docs/METRICS.md) can tell a bounce from a send that went through.
  const providerId = event.data?.email_id
  if (typeof providerId === 'string' && providerId.length <= 128) {
    await db.notificationDelivery.updateMany({ where: { providerId, channel: 'EMAIL' }, data: { status: 'FAILED', reason: complaint ? 'COMPLAINED' : 'BOUNCED' } })
  }
  return { handled: reason, addresses: addresses.length }
}
