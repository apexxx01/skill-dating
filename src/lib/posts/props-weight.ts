import { TIERS, type Tier } from '@/lib/levels'
import { accountDistrust } from '@/lib/trust'

// How much one Prop counts. A Prop is a vote of respect from one builder for a post, so it counts for more when it comes from somebody with a track
// record, and for nothing when it comes from an account the platform cannot yet vouch for. The weight is worked out when the Prop is given and stored on
// the row (never recomputed), and a post's propsScore is the sum of its Props' weights.
//
//   weight = tierFactor * ageFactor * verificationFactor            (0 for an untrusted giver)
//
//   tierFactor          1.0 for Bronze, +0.25 for each tier above it (Mythic 2.25)
//   ageFactor           the giver's account age in days over 90, from 0.4 up to 1 (a week-old account counts 0.4 * ..., a quarter-old one fully)
//   verificationFactor  0.7 with a verified email only, 0.85 with a phone, 1 with GitHub or anything above
//
// An untrusted giver (the trust gate: email not verified, or an account under 7 days old) gets weight 0: the Prop is recorded, so the giver sees it
// went through, but it adds nothing to the score and pays nothing. Weights are rounded to two decimals so the stored value is exact.

export const PROPS_WEIGHT_CONFIG = {
  tierStep: 0.25,
  ageFullDays: 90,
  ageFloor: 0.4,
  verification: { NONE: 0, EMAIL: 0.7, PHONE: 0.85, GITHUB: 1, PORTFOLIO: 1, ORGANIZATION: 1, IDENTITY: 1 },
} as const

export type VerificationLevelName = keyof typeof PROPS_WEIGHT_CONFIG.verification

export interface GiverFacts {
  tier: Tier
  createdAt: Date
  isEmailVerified: boolean
  verificationLevel: VerificationLevelName
}

const DAY_MS = 24 * 60 * 60 * 1000
const round2 = (value: number) => Math.round(value * 100) / 100

export function propWeight(giver: GiverFacts, now: Date = new Date()): number {
  // The trust gate decides first: no weight for an account that is too new or whose email is not verified.
  if (accountDistrust({ createdAt: giver.createdAt, isEmailVerified: giver.isEmailVerified }, now) !== null) return 0
  const tier = 1 + PROPS_WEIGHT_CONFIG.tierStep * Math.max(0, TIERS.indexOf(giver.tier))
  const ageDays = Math.max(0, (now.getTime() - giver.createdAt.getTime()) / DAY_MS)
  const { ageFloor, ageFullDays } = PROPS_WEIGHT_CONFIG
  const age = Math.min(1, ageFloor + (1 - ageFloor) * (ageDays / ageFullDays))
  const verification = PROPS_WEIGHT_CONFIG.verification[giver.verificationLevel] ?? 0
  return round2(tier * age * verification)
}
