import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { isDeliveryKind, type DeliveryKind } from './policy'

// Signed tokens for the links in emails. Nothing is stored: the token carries what the link is for and a signature over it, so a link works for as long as the
// secret does and cannot be forged or changed. Two purposes, never interchangeable (the purpose is part of what is signed):
//   unsubscribe  who, and which kind (or ALL). Never expires: a link in an old email has to keep working (CAN-SPAM asks 30 days at least, and a person digging an old
//                mail out of the archive is the one who most needs it).
//   open         which delivery, and where to send the person (a path inside the app, decided when the email was made). The click-through that measures email opens;
//                since the destination is signed, it cannot be turned into a redirect to somewhere else.

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
  /**
   * One kind, every optional email (ALL), or every email of the kinds that show only a neutral line (NEUTRAL). The token travels in a header and in the body of the email,
   * where anyone who sees the email can read it, so a kind that must not be named outside the app is never named in it: NEUTRAL stands for all of them.
   */
  kind: DeliveryKind | 'ALL' | 'NEUTRAL'
}

export const unsubscribeToken = (scope: UnsubscribeScope, secret?: string) => signToken('unsubscribe', { u: scope.userId, k: scope.kind }, secret)

export function readUnsubscribeToken(token: string, secret?: string): UnsubscribeScope | null {
  const payload = verifyToken('unsubscribe', token, secret)
  if (!payload?.u || !payload.k) return null
  if (payload.k !== 'ALL' && payload.k !== 'NEUTRAL' && !isDeliveryKind(payload.k)) return null
  return { userId: payload.u, kind: payload.k as UnsubscribeScope['kind'] }
}

export const openToken = (deliveryId: string, path: string, secret?: string) => signToken('open', { d: deliveryId, p: path }, secret)

export interface OpenTarget {
  deliveryId: string
  /** A path inside the app, starting with a single slash. */
  path: string
}

export function readOpenToken(token: string, secret?: string): OpenTarget | null {
  const payload = verifyToken('open', token, secret)
  if (!payload?.d || !payload.p) return null
  // Only a path in this app: a signed value is trusted, but never to send anyone to another site.
  if (!payload.p.startsWith('/') || payload.p.startsWith('//') || payload.p.includes('\\')) return null
  return { deliveryId: payload.d, path: payload.p }
}
