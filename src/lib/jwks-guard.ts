// Stops forged tokens from costing a Clerk API call each. The Clerk SDK re-fetches
// the signing keys from the Backend API whenever a token names a key id (kid) it
// does not have cached, and only afterwards checks anything else about the token.
// So anyone can send well-formed junk with random kids and make this server hammer
// Clerk (measured: about 100 ms of network per request), exhausting the API rate
// limit that the user sync and the webhook also depend on.
//
// The guard keeps the set of real kids and only lets a token reach the SDK when its
// kid is one of them. An unknown kid may trigger at most one refresh of that set per
// cooldown; if the kid is still unknown after the refresh the token is refused
// without calling the SDK. The refresh replaces the whole set, so a burst of junk
// can never prevent a genuine token (for a real, possibly newly rotated key) from
// being accepted once the refresh has run.

export interface KidGuardOptions {
  /** Minimum time between refreshes triggered by unknown kids or an expired set. */
  refreshCooldownMs?: number
  /** After this long the set is refreshed the next time a token arrives. */
  ttlMs?: number
  now?: () => number
}

export interface KidGuard {
  allows(kid: string): Promise<boolean>
}

export function createKidGuard(fetchKids: () => Promise<string[]>, options: KidGuardOptions = {}): KidGuard {
  const cooldown = options.refreshCooldownMs ?? 60_000
  const ttl = options.ttlMs ?? 5 * 60_000
  const now = options.now ?? Date.now

  let known = new Set<string>()
  let loadedAt = -Infinity
  let lastAttempt = -Infinity
  let inflight: Promise<void> | null = null

  function refresh(): Promise<void> {
    if (inflight) return inflight
    lastAttempt = now()
    inflight = fetchKids()
      .then((kids) => {
        known = new Set(kids)
        loadedAt = now()
      })
      .catch(() => {
        // Keep the old set: kids we already trust stay usable while Clerk is unreachable.
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return {
    async allows(kid: string): Promise<boolean> {
      if (!kid) return false
      const t = now()
      const fresh = t - loadedAt < ttl
      if (known.has(kid) && fresh) return true
      if (inflight) {
        await inflight
        return known.has(kid)
      }
      // Unknown kid, or a known one whose set has gone stale: refresh, but not more
      // often than the cooldown allows.
      if (t - lastAttempt >= cooldown) await refresh()
      return known.has(kid)
    },
  }
}

/** The kid from a JWT's header, or null when the token is not shaped like one. */
export function tokenKid(token: string): string | null {
  const [header] = token.split('.')
  if (!header) return null
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
    return typeof parsed?.kid === 'string' && parsed.kid.length > 0 && parsed.kid.length < 200 ? parsed.kid : null
  } catch {
    return null
  }
}
