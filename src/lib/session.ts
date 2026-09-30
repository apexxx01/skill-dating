import { clerkClient, verifyToken } from '@clerk/nextjs/server'
import { prisma } from '@/lib/prisma'
import { consumeSafely, type RateLimitDecision } from '@/lib/rate-limiter'
import { AccountConflictError, SELECTED_USER_FIELDS, syncClerkUser, type LocalUser } from '@/lib/user-sync'

// Request authentication. The session token is verified here, directly, against
// Clerk's signing keys. Nothing that middleware may have added to the request is
// trusted: on Next 14.1.0 a client can make middleware be skipped altogether
// (CVE-2025-29927), so authorization cannot depend on it.

export interface Identity {
  clerkId: string
  sessionId: string | null
  expiresAt: Date | null
}

export type AuthOutcome =
  | { kind: 'ok'; user: LocalUser; identity: Identity }
  | { kind: 'anonymous' }
  | { kind: 'deleted' }
  | { kind: 'conflict' }
  | { kind: 'limited'; decision: RateLimitDecision }
  | { kind: 'unavailable' }

interface SessionClaims {
  sub?: unknown
  sid?: unknown
  sts?: unknown
  exp?: unknown
}

const SESSION_COOKIE = '__session'
// A first-time sign-in causes one Clerk API call; bound it per Clerk account so
// a failing or hostile loop cannot turn into a stream of API calls.
const SYNC_LIMIT = { windowMs: 60_000, maxRequests: 10 }

/** Bearer token first, then the `__session` cookie Clerk sets in browsers. */
export function extractSessionToken(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  if (authorization && /^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, '').trim()
    return token || null
  }
  const cookie = headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      const value = part.slice(idx + 1).trim()
      return value || null
    }
  }
  return null
}

function authorizedParties(): string[] | undefined {
  const raw = process.env.CLERK_AUTHORIZED_PARTIES
  if (!raw) return undefined
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : undefined
}

/** Verifies signature, expiry and (when configured) authorized party. Null when invalid or absent. */
export async function verifyIdentity(headers: Headers): Promise<Identity | null> {
  const token = extractSessionToken(headers)
  if (!token) return null
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey) {
    console.error('CLERK_SECRET_KEY is not set: every request is treated as signed out')
    return null
  }
  try {
    // In @clerk/backend 1.x the exported verifyToken returns the verified claims
    // directly and THROWS on any failure (bad signature, expired, wrong party).
    // Its declared type does not say so, hence the explicit claims type.
    const claims = (await verifyToken(token, { secretKey, authorizedParties: authorizedParties() })) as unknown as SessionClaims
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) return null
    // A "pending" session has not finished sign-in (for example a required step is open).
    if (claims.sts === 'pending') return null
    return {
      clerkId: claims.sub,
      sessionId: typeof claims.sid === 'string' ? claims.sid : null,
      expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null,
    }
  } catch {
    return null
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 404
}

/** The local row for a verified Clerk account, created or linked on first sight. */
export async function resolveLocalUser(clerkId: string): Promise<Exclude<AuthOutcome, { kind: 'anonymous' }>> {
  const existing = await prisma.user.findUnique({ where: { clerkId }, select: SELECTED_USER_FIELDS })
  if (existing) return { kind: 'ok', user: existing, identity: { clerkId, sessionId: null, expiresAt: null } }

  const decision = await consumeSafely(`auth:sync:${clerkId}`, SYNC_LIMIT)
  if (!decision.allowed) return { kind: 'limited', decision }

  try {
    const clerkUser = await (await clerkClient()).users.getUser(clerkId)
    const user = await syncClerkUser(clerkUser)
    return { kind: 'ok', user, identity: { clerkId, sessionId: null, expiresAt: null } }
  } catch (error) {
    if (error instanceof AccountConflictError) return { kind: 'conflict' }
    // The token verified but Clerk no longer knows the account.
    if (isNotFound(error)) return { kind: 'deleted' }
    console.error('user sync failed:', error instanceof Error ? error.message : error)
    return { kind: 'unavailable' }
  }
}

export async function authenticate(headers: Headers): Promise<AuthOutcome> {
  const identity = await verifyIdentity(headers)
  if (!identity) return { kind: 'anonymous' }
  const outcome = await resolveLocalUser(identity.clerkId)
  if (outcome.kind !== 'ok') return outcome
  if (outcome.user.deletedAt) return { kind: 'deleted' }
  return { kind: 'ok', user: outcome.user, identity }
}
