import { MIN_TRUSTED_ACCOUNT_AGE_DAYS } from '@/lib/trust'

// Reach gating: what an account may do to reach other people, by how much the platform can vouch for it. Pure. A new account that has not verified its
// email can look around and build its profile, but cannot spray sparks or post to the public feed; reach opens as the account proves itself. The table is
// in docs/SAFETY.md ("Reach gating"); the numbers live here.
//
//   tier         who                                                  sparks a day   public posts and comments   host rooms, post bounties
//   UNVERIFIED   email not verified                                    1              no                          no
//   NEW          verified email, account younger than 7 days          3              yes                         no
//   TRUSTED      verified email, 7 days or older                      plan limit     yes                         no
//   VERIFIED     TRUSTED plus a phone, GitHub or higher verification  plan limit     yes                         yes
//
// A HIGH risk level (risk.ts) caps sparks at 1 a day whatever the tier.
// Rooms and bounties do not exist yet: `canHostRooms` and `canPostBounties` are the one place their gate will be read from.

export type ReachTier = 'UNVERIFIED' | 'NEW' | 'TRUSTED' | 'VERIFIED'

export interface ReachFacts {
  isEmailVerified: boolean
  createdAt: Date
  /** VerificationLevel: anything beyond NONE and EMAIL counts as strong. */
  verificationLevel: string
}

export interface Reach {
  tier: ReachTier
  /** A cap on sparks a day on top of the plan's limit; null means the plan's limit alone. */
  sparksPerDayCap: number | null
  canPostPublic: boolean
  canComment: boolean
  canHostRooms: boolean
  canPostBounties: boolean
}

export const REACH_CONFIG = {
  sparksPerDay: { UNVERIFIED: 1, NEW: 3, TRUSTED: null, VERIFIED: null } satisfies Record<ReachTier, number | null>,
  highRiskSparksPerDay: 1,
} as const

const DAY_MS = 24 * 60 * 60 * 1000
const STRONG_LEVELS = new Set(['PHONE', 'GITHUB', 'PORTFOLIO', 'ORGANIZATION', 'IDENTITY'])

export function reachTier(facts: ReachFacts, now: Date = new Date()): ReachTier {
  if (!facts.isEmailVerified) return 'UNVERIFIED'
  if (now.getTime() - facts.createdAt.getTime() < MIN_TRUSTED_ACCOUNT_AGE_DAYS * DAY_MS) return 'NEW'
  return STRONG_LEVELS.has(facts.verificationLevel) ? 'VERIFIED' : 'TRUSTED'
}

export function reachOf(facts: ReachFacts, options: { highRisk?: boolean; now?: Date } = {}): Reach {
  const tier = reachTier(facts, options.now)
  const byTier = REACH_CONFIG.sparksPerDay[tier]
  const sparksPerDayCap = options.highRisk ? Math.min(byTier ?? Infinity, REACH_CONFIG.highRiskSparksPerDay) : byTier
  return {
    tier,
    sparksPerDayCap,
    canPostPublic: tier !== 'UNVERIFIED',
    canComment: tier !== 'UNVERIFIED',
    canHostRooms: tier === 'VERIFIED',
    canPostBounties: tier === 'VERIFIED',
  }
}

/** The sparks a person may send today: the plan's limit, lowered by their reach cap. */
export function sparkAllowance(planLimit: number, reach: Pick<Reach, 'sparksPerDayCap'>): number {
  return reach.sparksPerDayCap === null ? planLimit : Math.min(planLimit, reach.sparksPerDayCap)
}
