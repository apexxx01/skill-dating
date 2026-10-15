import { describe, it, expect } from 'vitest'
import { emptyEnvelope, envelopeForGain, mergeEnvelopes } from './rewards-envelope'
import { xpAtLevelStart, TIER_START_LEVEL } from './levels'

describe('emptyEnvelope', () => {
  it('reports no change for a user who earned nothing', () => {
    expect(emptyEnvelope(150)).toEqual({
      xpGained: 0,
      totalXp: 150,
      oldLevel: 2,
      newLevel: 2,
      leveledUp: false,
      oldTier: 'BRONZE',
      newTier: 'BRONZE',
      tierChanged: false,
      achievements: [],
      questsCompleted: [],
      streak: null,
    })
  })
})

describe('envelopeForGain', () => {
  it('stays on the level when the gain does not reach the next one', () => {
    const envelope = envelopeForGain(0, 50)
    expect(envelope).toMatchObject({ xpGained: 50, totalXp: 50, oldLevel: 1, newLevel: 1, leveledUp: false, tierChanged: false })
  })

  it('levels up on exactly the threshold, not one XP before', () => {
    expect(envelopeForGain(0, 99).leveledUp).toBe(false)
    expect(envelopeForGain(0, 100)).toMatchObject({ oldLevel: 1, newLevel: 2, leveledUp: true })
    expect(envelopeForGain(99, 1)).toMatchObject({ oldLevel: 1, newLevel: 2, leveledUp: true })
  })

  it('can skip several levels in one gain', () => {
    expect(envelopeForGain(0, 1000)).toMatchObject({ oldLevel: 1, newLevel: 4, leveledUp: true })
  })

  it('changes tier at the tier boundary only', () => {
    const silver = xpAtLevelStart(TIER_START_LEVEL.SILVER)
    expect(envelopeForGain(silver - 2, 1)).toMatchObject({ oldLevel: 9, newLevel: 9, tierChanged: false, newTier: 'BRONZE' })
    expect(envelopeForGain(silver - 2, 2)).toMatchObject({ oldLevel: 9, newLevel: 10, leveledUp: true, tierChanged: true, oldTier: 'BRONZE', newTier: 'SILVER' })
    expect(envelopeForGain(silver, 5)).toMatchObject({ leveledUp: false, tierChanged: false, oldTier: 'SILVER' })
  })

  it('can cross more than one tier', () => {
    expect(envelopeForGain(0, xpAtLevelStart(TIER_START_LEVEL.GOLD))).toMatchObject({ oldTier: 'BRONZE', newTier: 'GOLD', tierChanged: true })
  })

  it('carries the achievements it is given', () => {
    expect(envelopeForGain(0, 25, [{ slug: 'first-project', name: 'First Project' }]).achievements).toEqual([
      { slug: 'first-project', name: 'First Project' },
    ])
  })
})

describe('mergeEnvelopes', () => {
  it('adds the XP, keeps the first start and the last end, and unions the achievements', () => {
    const first = envelopeForGain(60, 50, [{ slug: 'a', name: 'A' }])
    const second = envelopeForGain(110, 25, [{ slug: 'b', name: 'B' }])
    const merged = mergeEnvelopes(first, second)
    expect(merged).toMatchObject({ xpGained: 75, totalXp: 135, oldLevel: 1, newLevel: 2, leveledUp: true })
    expect(merged.achievements.map((item) => item.slug)).toEqual(['a', 'b'])
  })

  it('does not report a level-up that cancelled out', () => {
    // Same start and end level even though the middle total is higher.
    const merged = mergeEnvelopes(envelopeForGain(10, 5), envelopeForGain(15, 5))
    expect(merged).toMatchObject({ xpGained: 10, oldLevel: 1, newLevel: 1, leveledUp: false })
  })

  it('lists an achievement once', () => {
    const one = envelopeForGain(0, 0, [{ slug: 'a', name: 'A' }])
    expect(mergeEnvelopes(one, one).achievements).toHaveLength(1)
  })

  it('merging with an empty envelope changes nothing', () => {
    const earned = envelopeForGain(90, 20, [{ slug: 'a', name: 'A' }])
    expect(mergeEnvelopes(emptyEnvelope(90), earned)).toEqual(earned)
    expect(mergeEnvelopes(earned, emptyEnvelope(110))).toEqual(earned)
  })
})
