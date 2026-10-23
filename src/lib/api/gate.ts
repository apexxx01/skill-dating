import type { NextResponse } from 'next/server'
import type { PrismaClient } from '@prisma/client'
import { errorResponse } from '@/lib/api/errors'
import { closedAccountAllows, featureOfRequest } from '@/lib/api/request-features'
import { isHighRisk } from '@/lib/integrity/risk-job'
import { accountState } from '@/lib/moderation/restrictions'
import { isKilled, KILL_SWITCHES } from '@/lib/ops/kill-switches'
import { romanceOpenFor } from '@/lib/romance/launch'
import { staleConsents } from '@/lib/privacy/consent'
import { consumeSafely, tooManyRequests } from '@/lib/rate-limiter'

// The request gate: what withAuth (handler.ts) checks for every authenticated request after the session and before the route, so that no route can
// forget it. In order:
//   1. a banned or suspended account is closed to everything but its own account, data, notices and appeals (403 ACCOUNT_BANNED / ACCOUNT_SUSPENDED);
//   2. a feature under a kill switch answers its own 503 code (src/lib/ops/kill-switches.ts); the romance mode answers its code (ROMANCE_PAUSED) unless it has been opened for
//      this person (src/lib/romance/launch.ts): it ships closed;
//   3. a feature moderation restricted for this person answers 403 FEATURE_RESTRICTED (with the feature and until when);
//   4. a write by someone who accepted an older version of the terms or the privacy notice answers 403 CONSENT_REQUIRED until they accept again;
//   5. a write by a HIGH risk account counts against RISK_WRITE_LIMIT as well as the route's own limit.

/** Writes a HIGH risk account may make, across all routes. */
export const RISK_WRITE_LIMIT = { windowMs: 10 * 60_000, maxRequests: 30 } as const

const isWrite = (method: string) => method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'

/** Where re-consent is given (and what one can still do without it). */
function consentExempt(method: string, path: string): boolean {
  return path === '/api/users/me/consents' || path.startsWith('/api/users/me/consents/') || closedAccountAllows(method, path)
}

export async function gateRequest(db: PrismaClient, user: { id: string }, method: string, pathname: string): Promise<NextResponse | null> {
  const state = await accountState(db, user.id)
  if ((state.banned || state.suspendedUntil) && !closedAccountAllows(method, pathname)) {
    if (state.banned) return errorResponse('ACCOUNT_BANNED')
    return errorResponse('ACCOUNT_SUSPENDED', { params: { until: state.suspendedUntil! } })
  }

  const feature = featureOfRequest(method, pathname)
  if (feature) {
    if (feature === 'romance' ? !(await romanceOpenFor(db, user.id)) : await isKilled(db, feature)) return errorResponse(KILL_SWITCHES[feature].code)
    if (feature !== 'external_hackathons' && feature in state.restricted) {
      const until = state.restricted[feature]
      return errorResponse('FEATURE_RESTRICTED', { params: { feature, ...(until ? { until } : {}) } })
    }
  }

  if (isWrite(method) && !consentExempt(method, pathname)) {
    const stale = await staleConsents(db, user.id)
    if (stale.length > 0) return errorResponse('CONSENT_REQUIRED', { params: { documents: stale.map((type) => type.toLowerCase()).join(' and ') }, details: { consents: stale } })
    if (await isHighRisk(db, user.id)) {
      const decision = await consumeSafely(`risk:writes:${user.id}`, RISK_WRITE_LIMIT)
      if (!decision.allowed) return tooManyRequests(decision)
    }
  }
  return null
}
