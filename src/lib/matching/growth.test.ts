import { describe, it, expect } from 'vitest'
import { growthReason, growthSince, growthWeight, hasGrown, readSnapshot } from './growth'

describe('readSnapshot', () => {
  it('reads what a pass stores', () => {
    expect(readSnapshot({ tier: 'GOLD', verifiedEvidence: 3 })).toEqual({ tier: 'GOLD', verifiedEvidence: 3 })
    expect(readSnapshot({ tier: 'BRONZE', verifiedEvidence: 0, extra: 1 })).toEqual({ tier: 'BRONZE', verifiedEvidence: 0 })
  })

  it('refuses anything else', () => {
    for (const bad of [null, undefined, 'GOLD', 3, [], {}, { tier: 'GOLD' }, { verifiedEvidence: 2 }, { tier: 'PLUTONIUM', verifiedEvidence: 1 }, { tier: 'GOLD', verifiedEvidence: -1 }, { tier: 'GOLD', verifiedEvidence: 1.5 }, { tier: 'GOLD', verifiedEvidence: '2' }]) {
      expect(readSnapshot(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('growthSince', () => {
  it('counts tiers climbed and evidence gained', () => {
    expect(growthSince({ tier: 'SILVER', verifiedEvidence: 1 }, { tier: 'PLATINUM', verifiedEvidence: 4 })).toEqual({ tierSteps: 2, evidenceGained: 3 })
  })

  it('is zero for no change, and never negative', () => {
    expect(growthSince({ tier: 'GOLD', verifiedEvidence: 2 }, { tier: 'GOLD', verifiedEvidence: 2 })).toEqual({ tierSteps: 0, evidenceGained: 0 })
    expect(growthSince({ tier: 'GOLD', verifiedEvidence: 5 }, { tier: 'SILVER', verifiedEvidence: 1 })).toEqual({ tierSteps: 0, evidenceGained: 0 })
  })

  it('counts either alone', () => {
    expect(growthSince({ tier: 'GOLD', verifiedEvidence: 2 }, { tier: 'DIAMOND', verifiedEvidence: 2 })).toEqual({ tierSteps: 2, evidenceGained: 0 })
    expect(growthSince({ tier: 'GOLD', verifiedEvidence: 2 }, { tier: 'GOLD', verifiedEvidence: 3 })).toEqual({ tierSteps: 0, evidenceGained: 1 })
  })

  it('does not guess about a tier it does not know', () => {
    expect(growthSince({ tier: 'MADE_UP', verifiedEvidence: 0 }, { tier: 'GOLD', verifiedEvidence: 0 }).tierSteps).toBe(0)
  })
})

describe('hasGrown and growthWeight', () => {
  it('is true for a higher tier or more evidence only', () => {
    expect(hasGrown({ tierSteps: 1, evidenceGained: 0 })).toBe(true)
    expect(hasGrown({ tierSteps: 0, evidenceGained: 1 })).toBe(true)
    expect(hasGrown({ tierSteps: 0, evidenceGained: 0 })).toBe(false)
  })

  it('weighs a tier as five pieces of evidence', () => {
    expect(growthWeight({ tierSteps: 1, evidenceGained: 0 })).toBe(5)
    expect(growthWeight({ tierSteps: 1, evidenceGained: 2 })).toBeGreaterThan(growthWeight({ tierSteps: 0, evidenceGained: 6 }))
  })
})

describe('growthReason', () => {
  it('says what changed', () => {
    expect(growthReason({ tierSteps: 1, evidenceGained: 0 }, { tier: 'GOLD', verifiedEvidence: 2 })).toBe('Since you last saw them they moved up to Gold')
    expect(growthReason({ tierSteps: 0, evidenceGained: 1 }, { tier: 'GOLD', verifiedEvidence: 2 })).toBe('Since you last saw them they added 1 verified proof of their work')
    expect(growthReason({ tierSteps: 0, evidenceGained: 3 }, { tier: 'GOLD', verifiedEvidence: 2 })).toBe('Since you last saw them they added 3 verified proofs of their work')
    expect(growthReason({ tierSteps: 2, evidenceGained: 2 }, { tier: 'DIAMOND', verifiedEvidence: 5 })).toBe('Since you last saw them they moved up to Diamond and added 2 verified proofs of their work')
  })

  it('never guesses a pronoun', () => {
    expect(growthReason({ tierSteps: 1, evidenceGained: 1 }, { tier: 'GOLD', verifiedEvidence: 1 })).not.toMatch(/\b(she|he|her|his|him)\b/i)
  })
})
