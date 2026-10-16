import { describe, it, expect } from 'vitest'
import { COSMETIC_BY_SLUG, COSMETIC_DEFINITIONS, matchingCosmetics, requirementText, ruleMatches, SLOT_OF } from './cosmetic-definitions'
import { ACHIEVEMENT_DEFINITIONS } from './achievement-definitions'
import { TIERS } from './levels'

describe('the cosmetic catalog', () => {
  it('has about twenty starter cosmetics with unique slugs and a place in the order', () => {
    expect(COSMETIC_DEFINITIONS).toHaveLength(20)
    expect(new Set(COSMETIC_DEFINITIONS.map((c) => c.slug)).size).toBe(20)
    expect(COSMETIC_DEFINITIONS.map((c) => c.order).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect(COSMETIC_BY_SLUG.size).toBe(20)
  })

  it('has a title for every tier', () => {
    const tierTitles = COSMETIC_DEFINITIONS.filter((c) => c.type === 'TITLE' && c.unlockRule.type === 'TIER')
    expect(tierTitles.map((c) => (c.unlockRule as { tier: string }).tier)).toEqual([...TIERS])
  })

  it('has a frame for every streak milestone', () => {
    const frames = COSMETIC_DEFINITIONS.filter((c) => c.type === 'FRAME' && c.unlockRule.type === 'STREAK')
    expect(frames.map((c) => (c.unlockRule as { days: number }).days)).toEqual([7, 30, 100, 365])
  })

  it('has banners for hackathon wins', () => {
    const wins = COSMETIC_DEFINITIONS.filter((c) => c.type === 'BANNER' && c.unlockRule.type === 'ACHIEVEMENT' && c.unlockRule.slug.startsWith('hackathon-'))
    expect(wins.length).toBeGreaterThanOrEqual(3)
  })

  it('earns every cosmetic by a rule that refers to something real', () => {
    for (const cosmetic of COSMETIC_DEFINITIONS) {
      const rule = cosmetic.unlockRule
      if (rule.type === 'TIER') expect(TIERS, cosmetic.slug).toContain(rule.tier)
      if (rule.type === 'ACHIEVEMENT') expect(ACHIEVEMENT_DEFINITIONS, cosmetic.slug).toHaveProperty(rule.slug)
      if (rule.type === 'STREAK') expect(rule.days, cosmetic.slug).toBeGreaterThan(0)
      expect(['TIER', 'ACHIEVEMENT', 'STREAK']).toContain(rule.type)
    }
  })

  it('is never for sale: nothing in a definition names a price, a cost or a currency', () => {
    for (const cosmetic of COSMETIC_DEFINITIONS) {
      expect(Object.keys(cosmetic).sort(), cosmetic.slug).toEqual(['description', 'name', 'order', 'rarity', 'slug', 'type', 'unlockRule'])
      expect(JSON.stringify(cosmetic), cosmetic.slug).not.toMatch(/price|cost|buy|purchase|currency|coins?|gems?|usd|\$/i)
    }
  })

  it('makes the rarer cosmetics harder to earn', () => {
    const tierRarity = ['COMMON', 'COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']
    COSMETIC_DEFINITIONS.filter((c) => c.unlockRule.type === 'TIER').forEach((c, index) => expect(c.rarity).toBe(tierRarity[index]))
    expect(COSMETIC_BY_SLUG.get('frame-streak-365')!.rarity).toBe('LEGENDARY')
    expect(COSMETIC_BY_SLUG.get('frame-streak-7')!.rarity).toBe('COMMON')
  })

  it('puts each type in its own slot, and has no avatar parts yet', () => {
    expect(SLOT_OF).toEqual({ TITLE: 'title', FRAME: 'frame', BANNER: 'banner', AVATAR_PART: null })
    expect(COSMETIC_DEFINITIONS.filter((c) => c.type === 'AVATAR_PART')).toEqual([])
  })
})

describe('ruleMatches', () => {
  it('matches a tier reached, and every tier below it: nobody misses a title by skipping a tier', () => {
    const gold = { kind: 'TIER', tier: 'GOLD' } as const
    expect(ruleMatches({ type: 'TIER', tier: 'GOLD' }, gold)).toBe(true)
    expect(ruleMatches({ type: 'TIER', tier: 'SILVER' }, gold)).toBe(true)
    expect(ruleMatches({ type: 'TIER', tier: 'BRONZE' }, gold)).toBe(true)
    expect(ruleMatches({ type: 'TIER', tier: 'PLATINUM' }, gold)).toBe(false)
    expect(ruleMatches({ type: 'TIER', tier: 'MYTHIC' }, gold)).toBe(false)
  })

  it('matches a streak of at least the days asked', () => {
    expect(ruleMatches({ type: 'STREAK', days: 30 }, { kind: 'STREAK', days: 30 })).toBe(true)
    expect(ruleMatches({ type: 'STREAK', days: 30 }, { kind: 'STREAK', days: 31 })).toBe(true)
    expect(ruleMatches({ type: 'STREAK', days: 30 }, { kind: 'STREAK', days: 29 })).toBe(false)
  })

  it('matches only the achievement named', () => {
    expect(ruleMatches({ type: 'ACHIEVEMENT', slug: 'ship-100' }, { kind: 'ACHIEVEMENT', slug: 'ship-100' })).toBe(true)
    expect(ruleMatches({ type: 'ACHIEVEMENT', slug: 'ship-100' }, { kind: 'ACHIEVEMENT', slug: 'ship-25' })).toBe(false)
  })

  it('never matches a trigger of another kind', () => {
    expect(ruleMatches({ type: 'TIER', tier: 'BRONZE' }, { kind: 'STREAK', days: 999 })).toBe(false)
    expect(ruleMatches({ type: 'STREAK', days: 1 }, { kind: 'TIER', tier: 'MYTHIC' })).toBe(false)
    expect(ruleMatches({ type: 'ACHIEVEMENT', slug: 'ship-100' }, { kind: 'TIER', tier: 'MYTHIC' })).toBe(false)
  })
})

describe('matchingCosmetics', () => {
  it('finds the tier titles up to a tier', () => {
    expect(matchingCosmetics({ kind: 'TIER', tier: 'SILVER' }).map((c) => c.slug)).toEqual(['title-bronze', 'title-silver'])
    expect(matchingCosmetics({ kind: 'TIER', tier: 'MYTHIC' })).toHaveLength(6)
  })

  it('finds the frames up to a streak, and none for a short one', () => {
    expect(matchingCosmetics({ kind: 'STREAK', days: 100 }).map((c) => c.slug)).toEqual(['frame-streak-7', 'frame-streak-30', 'frame-streak-100'])
    expect(matchingCosmetics({ kind: 'STREAK', days: 6 })).toEqual([])
  })

  it('finds what one achievement earns, which can be more than one cosmetic', () => {
    expect(matchingCosmetics({ kind: 'ACHIEVEMENT', slug: 'hackathon-champion' }).map((c) => c.slug).sort()).toEqual(['banner-champion', 'title-champion'])
    expect(matchingCosmetics({ kind: 'ACHIEVEMENT', slug: 'first-project' })).toEqual([])
  })
})

describe('requirementText', () => {
  it('says what to do in words, naming achievements the way people see them', () => {
    expect(requirementText({ type: 'TIER', tier: 'GOLD' })).toBe('Reach the Gold tier')
    expect(requirementText({ type: 'STREAK', days: 30 })).toBe('Keep a 30 day streak')
    expect(requirementText({ type: 'ACHIEVEMENT', slug: 'ship-100' })).toBe('Unlock the achievement "Centurion"')
  })
})
