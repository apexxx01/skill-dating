import reserved from '@/config/reserved-usernames.json'
import { skeleton } from './confusables'

// Reserved names and look-alikes. Usernames come from Clerk and are copied locally (src/lib/username.ts); a name that is reserved, or that looks like
// a reserved name or like somebody else's name, is treated as taken there, so the person gets the same deterministic suffix as for any other
// collision ("admin" becomes "admin_k3j9x2"). The list is config (src/config/reserved-usernames.json), not code.

const RESERVED_SKELETONS = new Set(reserved.names.map((name) => skeleton(name)))

/** Reserved, or a look-alike of a reserved name. */
export function isReservedName(name: string): boolean {
  return RESERVED_SKELETONS.has(skeleton(name))
}

export type UsernameRefusal = 'RESERVED' | 'CONFUSABLE'

/**
 * Why `candidate` cannot be given to `ownerId`, or null when it can. `holderOfSkeleton` answers who already holds a name with this skeleton (any name
 * that reads the same), or null.
 */
export async function usernameRefusal(
  candidate: string,
  holderOfSkeleton: (skeleton: string) => Promise<string | null>,
  ownerId?: string
): Promise<UsernameRefusal | null> {
  if (isReservedName(candidate)) return 'RESERVED'
  const holder = await holderOfSkeleton(skeleton(candidate))
  if (holder !== null && holder !== ownerId) return 'CONFUSABLE'
  return null
}

/** Whether a display name may be shown: one that reads as a reserved name ("Admin", "Ѕupport") is refused. */
export function isAllowedDisplayName(name: string): boolean {
  return !isReservedName(name)
}
