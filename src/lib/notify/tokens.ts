import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { isDeliveryKind, type DeliveryKind } from './policy'

// Signed tokens for the links in emails. Nothing is stored: the token carries what the link is for and a signature over it, so a link works for as long as the
// secret does and cannot be forged or changed. Two purposes, never interchangeable (the purpose is part of what is signed):
//   unsubscribe  who, and which kind (or ALL). Never expires: a link in an old email has to keep working (CAN-SPAM asks 30 days at least, and a person digging an old
//                mail out of the archive is the one who most needs it).
//   open         which delivery. The click-through that measures email opens, and sends the person on to the notification's link.

export type TokenPurpose = 'unsubscribe' | 'open'

const SEPARATOR = '.'

/** The key links are signed with: NOTIFICATION_SIGNING_SECRET, or one derived from the Clerk secret key when that is not set. */
export function signingSecret(): string {
  if (env.NOTIFICATION_SIGNING_SECRET) return env.NOTIFICATION_SIGNING_SECRET
  return createHmac('sha256', env.CLERK_SECRET_KEY).update('notification-links-v1').digest('hex')
}

const mac = (secret: string, purpose: TokenPurpose, body: string) => createHmac('sha256', secret).update(`${purpose}:${body}`).digest('base64url')

export function signToken(purpose: TokenPurpose, payload: Record<string, string>, secret: string = signingSecret()): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}${SEPARATOR}${mac(secret, purpose, body)}`
}

/** The payload of a genuine token of this purpose, or null. */
export function verifyToken(purpose: TokenPurpose, token: string, secret: string = signingSecret()): Record<string, string> | null {
  if (token.length > 600) return null
  const [body, signature, ...rest] = token.split(SEPARATOR)
  if (!body || !signature || rest.length > 0) return null
  const expected = Buffer.from(mac(secret, purpose, body))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const entries = Object.entries(payload as Record<string, unknown>)
    return entries.every(([, value]) => typeof value === 'string') ? (payload as Record<string, string>) : null
  } catch {
    return null
  }
}

export interface UnsubscribeScope {
  userId: string
  /** One kind, or every optional email. */
  kind: DeliveryKind | 'ALL'
}

export const unsubscribeToken = (scope: UnsubscribeScope, secret?: string) => signToken('unsubscribe', { u: scope.userId, k: scope.kind }, secret)

export function readUnsubscribeToken(token: string, secret?: string): UnsubscribeScope | null {
  const payload = verifyToken('unsubscribe', token, secret)
  if (!payload?.u || !payload.k) return null
  if (payload.k !== 'ALL' && !isDeliveryKind(payload.k)) return null
  return { userId: payload.u, kind: payload.k as UnsubscribeScope['kind'] }
}

export const openToken = (deliveryId: string, secret?: string) => signToken('open', { d: deliveryId }, secret)

export function readOpenToken(token: string, secret?: string): string | null {
  return verifyToken('open', token, secret)?.d ?? null
}
