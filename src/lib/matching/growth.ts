import { TIERS } from '@/lib/levels'

// How much a person has grown since somebody passed on them: the pure half of the weekly "second look".

export interface ProofSnapshot {
  tier: string
  verifiedEvidence: number
}

export interface Growth {
  /** How many tiers higher they are now (0 if the same or lower). */
  tierSteps: number
  /** How many more verified pieces of evidence they have now (0 if the same or fewer). */
  evidenceGained: number
}

/** What a pass stored in `Drop.passSnapshot`, or null for anything that is not a snapshot. */
export function readSnapshot(value: unknown): ProofSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { tier, verifiedEvidence } = value as Record<string, unknown>
  if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier)) return null
  if (typeof verifiedEvidence !== 'number' || !Number.isInteger(verifiedEvidence) || verifiedEvidence < 0) return null
  return { tier, verifiedEvidence }
}

const tierIndex = (tier: string) => (TIERS as readonly string[]).indexOf(tier)

export function growthSince(before: ProofSnapshot, now: ProofSnapshot): Growth {
  const a = tierIndex(before.tier)
  const b = tierIndex(now.tier)
  return {
    tierSteps: a >= 0 && b >= 0 ? Math.max(0, b - a) : 0,
    evidenceGained: Math.max(0, now.verifiedEvidence - before.verifiedEvidence),
  }
}

/** Whether they are worth a second look: a higher tier or more verified evidence. */
export const hasGrown = (growth: Growth) => growth.tierSteps > 0 || growth.evidenceGained > 0

/** For choosing the most changed of several: a tier counts as much as five pieces of evidence. */
export const growthWeight = (growth: Growth) => growth.tierSteps * 5 + growth.evidenceGained

const label = (tier: string) => `${tier.charAt(0)}${tier.slice(1).toLowerCase()}`

/** The line shown on a second-look drop. */
export function growthReason(growth: Growth, now: ProofSnapshot): string {
  const parts: string[] = []
  if (growth.tierSteps > 0) parts.push(`moved up to ${label(now.tier)}`)
  if (growth.evidenceGained > 0) parts.push(`added ${growth.evidenceGained} verified ${growth.evidenceGained === 1 ? 'proof' : 'proofs'} of their work`)
  return `Since you last saw them they ${parts.join(' and ')}`
}
