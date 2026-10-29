import type { ConsentRecord, ConsentType, Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import versions from '@/config/legal-versions.json'
import { getCache, type Cache } from '@/lib/infra/cache'

// Consent records (GDPR Art. 7, DPDP Act s.6): what a person agreed to, which version, when, where, and when they withdrew it. Append-only: granting adds
// a row, withdrawing stamps the latest grant. The current version of each document is config (src/config/legal-versions.json).
//
//   TERMS, PRIVACY  recorded at onboarding (onboarding is complete only with both, while CONSENT_REQUIRED is on). Raising a version asks everybody who
//                   accepted an older one to accept again: their writes answer 403 CONSENT_REQUIRED until they do (src/lib/api/gate.ts).
//   ROMANCE_MODE    explicit consent before the romance mode can be turned on: gender and who someone is interested in reveal sexual orientation,
//                   special-category data. Withdrawing it turns the mode off and deletes the profile, filters, photos and reveal state (romance/consent.ts).
//   MARKETING       optional, off unless granted.
//   GITHUB_SYNC     optional: reading the person's public GitHub history for the evidence engine (src/lib/evidence). Withdrawing it stops every sync and
//                   hides what the engine found (it comes back if the consent is given again); receipts already issued stay valid but their pages
//                   answer 404 while it is withdrawn.

type Db = PrismaClient | Prisma.TransactionClient

export const CONSENT_TYPES = ['TERMS', 'PRIVACY', 'ROMANCE_MODE', 'MARKETING', 'GITHUB_SYNC'] as const
export const REQUIRED_CONSENTS: readonly ConsentType[] = ['TERMS', 'PRIVACY']
export const CURRENT_VERSIONS: Record<ConsentType, string> = { TERMS: versions.TERMS, PRIVACY: versions.PRIVACY, ROMANCE_MODE: versions.ROMANCE_MODE, MARKETING: versions.MARKETING, GITHUB_SYNC: versions.GITHUB_SYNC }

export const grantConsentSchema = z
  .object({
    type: z.enum(CONSENT_TYPES),
    version: z.string().max(32).regex(/^\d{4}-\d{2}-\d{2}$/, 'A version such as 2026-10-01'),
    source: z.enum(['onboarding', 'settings', 'romance-optin', 'github-connect', 'api']).default('settings'),
  })
  .strict()

export interface ConsentState {
  type: ConsentType
  currentVersion: string
  /** The version of the latest grant still in force, or null. */
  grantedVersion: string | null
  grantedAt: string | null
  /** Given and not withdrawn, for the current version. */
  current: boolean
  /** Given once, for an older version: must be accepted again. */
  stale: boolean
}

/** Pure: each type's state from a person's records. */
export function consentStates(records: readonly Pick<ConsentRecord, 'type' | 'version' | 'grantedAt' | 'withdrawnAt'>[]): Record<ConsentType, ConsentState> {
  const out = {} as Record<ConsentType, ConsentState>
  for (const type of CONSENT_TYPES) {
    const latest = records.filter((r) => r.type === type).sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())[0]
    const live = latest && !latest.withdrawnAt ? latest : null
    const currentVersion = CURRENT_VERSIONS[type]
    out[type] = {
      type,
      currentVersion,
      grantedVersion: live?.version ?? null,
      grantedAt: live?.grantedAt.toISOString() ?? null,
      current: live !== null && live.version >= currentVersion,
      stale: live !== null && live.version < currentVersion,
    }
  }
  return out
}

/** The required documents this person must accept again (an older version on file). Empty when they never accepted any: onboarding asks for those. */
export function staleRequired(states: Record<ConsentType, ConsentState>): ConsentType[] {
  return REQUIRED_CONSENTS.filter((type) => states[type].stale)
}

/** The required documents not yet accepted in their current version (for onboarding and GET /api/users/me). */
export function missingRequired(states: Record<ConsentType, ConsentState>): ConsentType[] {
  return REQUIRED_CONSENTS.filter((type) => !states[type].current)
}

export async function loadConsentStates(db: Db, userId: string): Promise<Record<ConsentType, ConsentState>> {
  const records = await db.consentRecord.findMany({ where: { userId }, select: { type: true, version: true, grantedAt: true, withdrawnAt: true } })
  return consentStates(records)
}

const cacheKey = (userId: string) => `consent-stale:${userId}`

/** The stale required consents, cached for a minute (read by the request gate on every write); dropped on every change. */
export async function staleConsents(db: Db, userId: string, cache: Cache = getCache()): Promise<ConsentType[]> {
  try {
    const hit = await cache.get(cacheKey(userId))
    if (hit) return JSON.parse(hit) as ConsentType[]
  } catch {
    // read the database
  }
  const stale = staleRequired(await loadConsentStates(db, userId))
  await cache.set(cacheKey(userId), JSON.stringify(stale), { ttlMs: 60_000 }).catch(() => undefined)
  return stale
}

export async function invalidateConsentCache(userId: string, cache: Cache = getCache()): Promise<void> {
  await cache.del(cacheKey(userId)).catch(() => undefined)
}

export type GrantFailure = 'CONSENT_VERSION_UNKNOWN'

/** Records a grant of the current version. A grant of another version is refused: nobody can agree to a document that is not the one in force. */
export async function grantConsent(db: Db, userId: string, input: { type: ConsentType; version: string; source: string }, now: Date = new Date()): Promise<ConsentRecord | GrantFailure> {
  if (input.version !== CURRENT_VERSIONS[input.type]) return 'CONSENT_VERSION_UNKNOWN'
  const record = await db.consentRecord.create({ data: { userId, type: input.type, version: input.version, source: input.source, grantedAt: now } })
  await invalidateConsentCache(userId)
  return record
}

/** Stamps the latest grant of a type as withdrawn. Returns whether there was one in force. TERMS and PRIVACY are withdrawn by deleting the account. */
export async function withdrawConsent(db: Db, userId: string, type: ConsentType, now: Date = new Date()): Promise<boolean> {
  const latest = await db.consentRecord.findFirst({ where: { userId, type }, orderBy: { grantedAt: 'desc' } })
  if (!latest || latest.withdrawnAt) return false
  await db.consentRecord.update({ where: { id: latest.id }, data: { withdrawnAt: now } })
  await invalidateConsentCache(userId)
  return true
}
