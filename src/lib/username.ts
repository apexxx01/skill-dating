// Deterministic local username for a Clerk account. The Clerk username is
// copied as-is when it is free; when another local user already has it the
// request must still succeed, so a suffix derived from the Clerk id is added.
// Given a Clerk id and a set of taken names the answer is always the same, and
// it never depends on timing or randomness.

export const MAX_USERNAME_LENGTH = 30

const FALLBACK_BASE = 'user'
const FIRST_SUFFIX_LENGTH = 6
const SUFFIX_STEP = 2

/** Lowercase, keep [a-z0-9_-], never empty, at most MAX_USERNAME_LENGTH. */
export function sanitizeUsername(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, MAX_USERNAME_LENGTH)
  return cleaned || FALLBACK_BASE
}

/** The part of a Clerk id after the `user_` prefix, lowercased and alphanumeric. */
function idBody(clerkId: string): string {
  return clerkId.replace(/^user_/i, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Candidates in the order they are tried: the plain name, then longer and longer suffixes. */
export function usernameCandidates(base: string, clerkId: string): string[] {
  const clean = sanitizeUsername(base)
  const body = idBody(clerkId)
  const out = [clean]
  for (let len = FIRST_SUFFIX_LENGTH; len <= body.length; len += SUFFIX_STEP) {
    const suffix = `_${body.slice(0, len)}`
    out.push(clean.slice(0, MAX_USERNAME_LENGTH - suffix.length) + suffix)
  }
  // The full id, in case the loop above stopped one character short of it.
  const full = `_${body}`
  const last = clean.slice(0, MAX_USERNAME_LENGTH - full.length) + full
  if (body.length > 0 && !out.includes(last)) out.push(last)
  return out
}

/**
 * First candidate that is not taken by someone else. `takenBy` returns the id of
 * the local user holding a name, or null when it is free; a name held by
 * `ownerId` counts as free (the account already owns it).
 */
export async function resolveUsername(
  base: string | null | undefined,
  clerkId: string,
  takenBy: (username: string) => Promise<string | null>,
  ownerId?: string
): Promise<string> {
  const candidates = usernameCandidates(base ?? '', clerkId)
  for (const candidate of candidates) {
    const holder = await takenBy(candidate)
    if (holder === null || holder === ownerId) return candidate
  }
  // Every candidate taken (a full Clerk id is unique, so this means the id
  // itself was used as someone's name). Fall back to the id verbatim.
  return candidates[candidates.length - 1]
}

/**
 * True when `current` is already a name this Clerk account would be given for
 * `base` (the plain name or one of its suffixed forms). Used so that a name that
 * was suffixed because of an earlier collision does not flip back to the plain
 * name just because that name has since become free.
 */
export function isCurrentUsernameFor(current: string, base: string | null | undefined, clerkId: string): boolean {
  return usernameCandidates(base ?? '', clerkId).includes(current)
}
