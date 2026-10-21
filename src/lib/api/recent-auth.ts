import { clerkClient } from '@clerk/nextjs/server'
import { errorResponse } from '@/lib/api/errors'
import { log } from '@/lib/log'
import type { NextResponse } from 'next/server'

// Destructive admin actions (a ban, removing content, verification changes, plan overrides) need a session that signed in recently: a stolen session
// cookie that is hours old cannot do them. Clerk's session token carries `fva`, the minutes since the first and second factors were verified; when it is
// there and says the first factor was verified, that is used. Otherwise the session's own age is asked of Clerk. Either must be under the limit.

export const RECENT_AUTH_MAX_MINUTES = 10

export interface SessionInfo {
  id: string | null
  /** Minutes since the first factor was verified, from the token's `fva` claim; null when the token has none (or it says never). */
  factorAgeMinutes: number | null
}

// Clerk writes 99999 (not a real age) into `fva` when it does not know when a factor was verified, as for a session created through its backend API;
// -1 means never verified. Neither is an age, so both leave the decision to the session's own age.
export const FVA_UNKNOWN = 99999

/** Pure: the first factor's age in minutes from a token's `fva` claim, or null when the claim gives none. */
export function factorAgeFromClaim(fva: unknown): number | null {
  if (!Array.isArray(fva) || typeof fva[0] !== 'number' || !Number.isFinite(fva[0])) return null
  return fva[0] >= 0 && fva[0] < FVA_UNKNOWN ? fva[0] : null
}

/** Pure: the decision from what is known. */
export function isRecentAuth(input: { factorAgeMinutes: number | null; sessionCreatedAt: Date | null; now: Date; maxMinutes?: number }): boolean {
  const max = input.maxMinutes ?? RECENT_AUTH_MAX_MINUTES
  if (input.factorAgeMinutes !== null) return input.factorAgeMinutes <= max
  if (input.sessionCreatedAt) return input.now.getTime() - input.sessionCreatedAt.getTime() <= max * 60_000
  return false
}

/** Null when the caller signed in recently enough, else the 403 REAUTH_REQUIRED response. */
export async function requireRecentAuth(session: SessionInfo, now: Date = new Date()): Promise<NextResponse | null> {
  let createdAt: Date | null = null
  if (session.factorAgeMinutes === null && session.id) {
    try {
      const found = await (await clerkClient()).sessions.getSession(session.id)
      createdAt = new Date(found.createdAt)
    } catch (error) {
      log.warn('could not read the session age', { error })
    }
  }
  if (isRecentAuth({ factorAgeMinutes: session.factorAgeMinutes, sessionCreatedAt: createdAt, now })) return null
  return errorResponse('REAUTH_REQUIRED', { params: { maxAgeMinutes: RECENT_AUTH_MAX_MINUTES } })
}
