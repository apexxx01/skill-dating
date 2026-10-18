import { describe, it, expect } from 'vitest'
import { COSMETIC_BY_SLUG, COSMETIC_DEFINITIONS, cosmeticDefinition, matchingCosmetics, MAX_BADGES_SHOWN, parseSeasonSlug, requirementText, ruleMatches, SEASON_AWARDS, seasonAwardCutoffs, seasonCosmetic, seasonCosmeticSlug, SLOT_OF } from './cosmetic-definitions'
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
      expect(['TIER', 'ACHIEVEMENT', 'STREAK']).toContain(rule.type) // the fixed catalog has no season rules; a season's are made per season
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
    expect(SLOT_OF).toEqual({ TITLE: 'title', FRAME: 'frame', BANNER: 'banner', BADGE: 'badges', AVATAR_PART: null })
    expect(COSMETIC_DEFINITIONS.filter((c) => c.type === 'AVATAR_PART')).toEqual([])
  })

  it('shows at most three badges', () => {
    expect(MAX_BADGES_SHOWN).toBe(3)
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

describe('season cosmetics', () => {
  it('has a title for the top 100, a frame for the top 1% and another for the top 10%, and a badge for everyone who played', () => {
    const [title, apex, strong, badge] = SEASON_AWARDS.map((award) => seasonCosmetic(3, award))
    expect(title).toMatchObject({ slug: 'season-3-top-100', type: 'TITLE', name: 'Season 3 Top 100' })
    expect(apex).toMatchObject({ slug: 'season-3-top-1-percent', type: 'FRAME', name: 'Season 3 Top 1%', rarity: 'LEGENDARY' })
    expect(strong).toMatchObject({ slug: 'season-3-top-10-percent', type: 'FRAME', name: 'Season 3 Top 10%' })
    expect(badge).toMatchObject({ slug: 'season-3-participant', type: 'BADGE', name: 'Season 3 Participant', rarity: 'COMMON' })
    expect(SEASON_AWARDS).toEqual(['TOP_100', 'TOP_1_PERCENT', 'TOP_10_PERCENT', 'PARTICIPANT'])
  })

  it('is a new set for every season, named for it, and never collides with the fixed catalog', () => {
    const slugs = new Set<string>()
    for (const season of [1, 2, 3, 40]) for (const award of SEASON_AWARDS) slugs.add(seasonCosmetic(season, award).slug)
    expect(slugs.size).toBe(16)
    for (const slug of slugs) expect(COSMETIC_BY_SLUG.has(slug), slug).toBe(false)
  })

  it('puts the rarer awards higher: the apex frame above the title above the top-10% frame above the badge', () => {
    const order = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']
    const rank = (award: (typeof SEASON_AWARDS)[number]) => order.indexOf(seasonCosmetic(1, award).rarity)
    expect(rank('TOP_1_PERCENT')).toBeGreaterThan(rank('TOP_100'))
    expect(rank('TOP_100')).toBeGreaterThan(rank('TOP_10_PERCENT'))
    expect(rank('TOP_10_PERCENT')).toBeGreaterThan(rank('PARTICIPANT'))
  })

  it('sorts after the fixed catalog, season by season, and is never for sale', () => {
    const fixedLast = Math.max(...COSMETIC_DEFINITIONS.map((cosmetic) => cosmetic.order))
    expect(seasonCosmetic(1, 'TOP_100').order).toBeGreaterThan(fixedLast)
    expect(seasonCosmetic(2, 'PARTICIPANT').order).toBeGreaterThan(seasonCosmetic(1, 'PARTICIPANT').order)
    for (const award of SEASON_AWARDS) {
      const cosmetic = seasonCosmetic(2, award)
      expect(Object.keys(cosmetic).sort()).toEqual(['description', 'name', 'order', 'rarity', 'slug', 'type', 'unlockRule'])
      expect(JSON.stringify(cosmetic)).not.toMatch(/price|cost|buy|purchase|currency|coins?|gems?|usd|\$/i)
    }
  })

  it('knows a season cosmetic by its slug, and nothing that merely looks like one', () => {
    for (const season of [1, 9, 123]) for (const award of SEASON_AWARDS) expect(parseSeasonSlug(seasonCosmeticSlug(season, award))).toEqual({ season, award })
    for (const bad of ['season-0-top-100', 'season-01-top-100', 'season--1-top-100', 'season-1-top-101', 'season-1-top-100x', 'xseason-1-top-100', 'season-1234567-top-100', 'season-1-', 'title-gold', '']) {
      expect(parseSeasonSlug(bad), bad).toBeNull()
    }
  })

  it('looks a cosmetic up among the fixed ones and the season ones', () => {
    expect(cosmeticDefinition('title-gold')?.name).toBe('Gold Maker')
    expect(cosmeticDefinition('season-2-top-100')).toEqual(seasonCosmetic(2, 'TOP_100'))
    expect(cosmeticDefinition('season-2-nonsense')).toBeUndefined()
    expect(cosmeticDefinition('nothing')).toBeUndefined()
  })

  it('wears in the same slots as the fixed ones: the title as a title, the frames as frames, the badge in the badges slot', () => {
    expect(SLOT_OF[seasonCosmetic(1, 'TOP_100').type]).toBe('title')
    expect(SLOT_OF[seasonCosmetic(1, 'TOP_1_PERCENT').type]).toBe('frame')
    expect(SLOT_OF[seasonCosmetic(1, 'TOP_10_PERCENT').type]).toBe('frame')
    expect(SLOT_OF[seasonCosmetic(1, 'PARTICIPANT').type]).toBe('badges')
  })

  it('is never earned by something a person does: no trigger matches a season rule', () => {
    const rule = seasonCosmetic(1, 'TOP_100').unlockRule
    for (const trigger of [{ kind: 'TIER', tier: 'MYTHIC' }, { kind: 'ACHIEVEMENT', slug: 'ship-100' }, { kind: 'STREAK', days: 9999 }] as const) {
      expect(ruleMatches(rule, trigger)).toBe(false)
    }
    expect(matchingCosmetics({ kind: 'TIER', tier: 'MYTHIC' }).some((cosmetic) => cosmetic.unlockRule.type === 'SEASON')).toBe(false)
  })

  it('says what earns it, in words', () => {
    expect(requirementText(seasonCosmetic(4, 'TOP_100').unlockRule)).toBe('Finish in the top 100 of Season 4')
    expect(requirementText(seasonCosmetic(4, 'TOP_1_PERCENT').unlockRule)).toBe('Finish in the top 1% of Season 4')
    expect(requirementText(seasonCosmetic(4, 'TOP_10_PERCENT').unlockRule)).toBe('Finish in the top 10% of Season 4')
    expect(requirementText(seasonCosmetic(4, 'PARTICIPANT').unlockRule)).toBe('Earn XP in Season 4')
  })
})

describe('seasonAwardCutoffs', () => {
  it('is the top 100, and a percent of the field rounded up', () => {
    expect(seasonAwardCutoffs(10_000)).toEqual({ TOP_100: 100, TOP_1_PERCENT: 100, TOP_10_PERCENT: 1000 })
    expect(seasonAwardCutoffs(250)).toEqual({ TOP_100: 100, TOP_1_PERCENT: 3, TOP_10_PERCENT: 25 })
    expect(seasonAwardCutoffs(1001)).toEqual({ TOP_100: 100, TOP_1_PERCENT: 11, TOP_10_PERCENT: 101 })
  })

  it('gives a small season’s winner every placing, and an empty season nothing', () => {
    expect(seasonAwardCutoffs(1)).toEqual({ TOP_100: 1, TOP_1_PERCENT: 1, TOP_10_PERCENT: 1 })
    expect(seasonAwardCutoffs(5)).toEqual({ TOP_100: 5, TOP_1_PERCENT: 1, TOP_10_PERCENT: 1 })
    expect(seasonAwardCutoffs(100)).toEqual({ TOP_100: 100, TOP_1_PERCENT: 1, TOP_10_PERCENT: 10 })
    expect(seasonAwardCutoffs(0)).toEqual({ TOP_100: 0, TOP_1_PERCENT: 0, TOP_10_PERCENT: 0 })
    expect(seasonAwardCutoffs(-3)).toEqual({ TOP_100: 0, TOP_1_PERCENT: 0, TOP_10_PERCENT: 0 })
  })

  it('never reaches further down for a bigger prize', () => {
    for (const ranked of [0, 1, 7, 99, 100, 101, 999, 1000, 54321]) {
      const cutoffs = seasonAwardCutoffs(ranked)
      expect(cutoffs.TOP_1_PERCENT).toBeLessThanOrEqual(cutoffs.TOP_10_PERCENT)
      expect(cutoffs.TOP_100).toBeLessThanOrEqual(ranked)
      expect(cutoffs.TOP_10_PERCENT).toBeLessThanOrEqual(ranked)
    }
  })
})
