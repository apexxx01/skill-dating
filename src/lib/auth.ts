import { headers } from 'next/headers'
import { authenticate, type AuthOutcome } from '@/lib/session'

// Server-side session lookup for server components and for the compat session
// route. The shape is the one NextAuth's auth() used to return, so the frozen
// frontend files that call it keep compiling and working. `user.id` is the LOCAL
// user id, never the Clerk id. The token is verified on every call (see
// session.ts); nothing middleware sets is read.

export interface AppSession {
  user: {
    id: string
    name: string | null
    email: string
    image: string | null
    role: string
  }
  expires: string
}

// Sessions are 60 seconds at Clerk; when a token has no exp claim fall back to the same window.
const FALLBACK_TTL_MS = 60_000

export function toSession(outcome: AuthOutcome): AppSession | null {
  if (outcome.kind !== 'ok') return null
  const { user, identity } = outcome
  return {
    user: { id: user.id, name: user.name, email: user.email, image: user.image, role: user.role },
    expires: (identity.expiresAt ?? new Date(Date.now() + FALLBACK_TTL_MS)).toISOString(),
  }
}

export async function auth(): Promise<AppSession | null> {
  return toSession(await authenticate(headers()))
}
