import type { User as ClerkUser } from '@clerk/nextjs/server'
import { AccountConflictError } from '@/lib/user-sync'

// What to do with a verified Clerk webhook event. The payload is only a change
// notification: for created/updated the user is fetched from Clerk again and the
// CURRENT state is applied, so a replayed or reordered old event cannot roll
// anything back. Every branch is idempotent.

export interface WebhookDeps {
  fetchUser: (clerkId: string) => Promise<ClerkUser>
  sync: (user: ClerkUser) => Promise<unknown>
  tombstone: (clerkId: string) => Promise<boolean>
}

export type WebhookResult =
  | { status: 'synced' }
  | { status: 'tombstoned'; found: boolean }
  | { status: 'conflict' }
  | { status: 'ignored'; reason: string }

interface ClerkEvent {
  type?: unknown
  data?: { id?: unknown } | null
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 404
}

export async function processClerkEvent(event: ClerkEvent, deps: WebhookDeps): Promise<WebhookResult> {
  const type = typeof event.type === 'string' ? event.type : ''
  const clerkId = typeof event.data?.id === 'string' ? event.data.id : ''

  if (type !== 'user.created' && type !== 'user.updated' && type !== 'user.deleted') {
    return { status: 'ignored', reason: 'event type not handled' }
  }
  if (!clerkId) return { status: 'ignored', reason: 'event has no user id' }

  // Clerk ids are never reused, so a deletion is final and needs no re-check.
  if (type === 'user.deleted') return { status: 'tombstoned', found: await deps.tombstone(clerkId) }

  let user: ClerkUser
  try {
    user = await deps.fetchUser(clerkId)
  } catch (error) {
    // An old created/updated event arriving after the account was deleted.
    if (isNotFound(error)) return { status: 'tombstoned', found: await deps.tombstone(clerkId) }
    throw error
  }

  try {
    await deps.sync(user)
    return { status: 'synced' }
  } catch (error) {
    // Permanent (the email belongs to another account); retrying cannot help.
    if (error instanceof AccountConflictError) return { status: 'conflict' }
    throw error
  }
}
