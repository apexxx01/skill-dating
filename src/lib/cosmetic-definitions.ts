import { ACHIEVEMENT_DEFINITIONS, type AchievementSlug } from '@/lib/achievement-definitions'
import type { Tier } from '@/lib/levels'

// The cosmetics: titles, frames and banners for a profile. They are EARNED and only earned: each has an
// unlock rule, and src/lib/cosmetics.ts grants one only when something that happens to a person matches it.
// There is no price, no purchase and no route that hands one out (a test checks all three).
//
//  - TIER: reaching a tier (or any higher one, so a person who is already Gold also gets the Silver title);
//  - ACHIEVEMENT: unlocking an achievement;
//  - STREAK: a daily streak of that many days (or more);
//  - SEASON: how a person finished a season (a placing, or just having played). These are granted by the rollover job
//    when a season closes, from its final standings, and there is a new set for every season ("Season 3 Top 100").
//    They pay no XP and cost nothing.

/** What a season can give: a title for the top 100, a frame for the top 1% and another for the top 10%, a badge for everyone who played. */
export type SeasonAward = 'TOP_100' | 'TOP_1_PERCENT' | 'TOP_10_PERCENT' | 'PARTICIPANT'

export type CosmeticType = 'TITLE' | 'FRAME' | 'BANNER' | 'BADGE' | 'AVATAR_PART'
export type CosmeticRarity = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY'

export type UnlockRule =
  | { type: 'TIER'; tier: Tier }
  | { type: 'ACHIEVEMENT'; slug: AchievementSlug }
  | { type: 'STREAK'; days: number }
  | { type: 'SEASON'; season: number; award: SeasonAward }

export interface CosmeticDefinition {
  slug: string
  type: CosmeticType
  name: string
  description: string
  rarity: CosmeticRarity
  unlockRule: UnlockRule
  order: number
}

export type CosmeticSlot = 'title' | 'frame' | 'banner' | 'badges'

/** Which slot of `User.equipped` a type goes in. Avatar parts have no slot yet. */
export const SLOT_OF: Record<CosmeticType, CosmeticSlot | null> = {
  TITLE: 'title',
  FRAME: 'frame',
  BANNER: 'banner',
  BADGE: 'badges',
  AVATAR_PART: null,
}

/** Title, frame and banner hold one cosmetic each; the badges slot holds a few, in the order the person chose. */
export const MAX_BADGES_SHOWN = 3

export const COSMETIC_DEFINITIONS: readonly CosmeticDefinition[] = [
  // --- A title for every tier ---------------------------------------------------------------
  { slug: 'title-bronze', type: 'TITLE', name: 'Bronze Builder', description: 'Earned your first XP.', rarity: 'COMMON', unlockRule: { type: 'TIER', tier: 'BRONZE' }, order: 1 },
  { slug: 'title-silver', type: 'TITLE', name: 'Silver Shipper', description: 'Reached the Silver tier.', rarity: 'COMMON', unlockRule: { type: 'TIER', tier: 'SILVER' }, order: 2 },
  { slug: 'title-gold', type: 'TITLE', name: 'Gold Maker', description: 'Reached the Gold tier.', rarity: 'UNCOMMON', unlockRule: { type: 'TIER', tier: 'GOLD' }, order: 3 },
  { slug: 'title-platinum', type: 'TITLE', name: 'Platinum Architect', description: 'Reached the Platinum tier.', rarity: 'RARE', unlockRule: { type: 'TIER', tier: 'PLATINUM' }, order: 4 },
  { slug: 'title-diamond', type: 'TITLE', name: 'Diamond Founder', description: 'Reached the Diamond tier.', rarity: 'EPIC', unlockRule: { type: 'TIER', tier: 'DIAMOND' }, order: 5 },
  { slug: 'title-mythic', type: 'TITLE', name: 'Mythic Visionary', description: 'Reached the Mythic tier.', rarity: 'LEGENDARY', unlockRule: { type: 'TIER', tier: 'MYTHIC' }, order: 6 },

  // --- Titles for achievements ----------------------------------------------------------------
  { slug: 'title-centurion', type: 'TITLE', name: 'Centurion', description: 'Shipped 100 projects.', rarity: 'EPIC', unlockRule: { type: 'ACHIEVEMENT', slug: 'ship-100' }, order: 7 },
  { slug: 'title-kingmaker', type: 'TITLE', name: 'Kingmaker', description: "Endorsed 50 builders' work.", rarity: 'RARE', unlockRule: { type: 'ACHIEVEMENT', slug: 'endorser-50' }, order: 8 },
  { slug: 'title-champion', type: 'TITLE', name: 'Champion', description: 'Won 3 hackathons.', rarity: 'EPIC', unlockRule: { type: 'ACHIEVEMENT', slug: 'hackathon-champion' }, order: 9 },
  { slug: 'title-night-owl', type: 'TITLE', name: 'Night Owl', description: 'Shipped in the small hours.', rarity: 'RARE', unlockRule: { type: 'ACHIEVEMENT', slug: 'night-owl' }, order: 10 },
  { slug: 'title-comeback', type: 'TITLE', name: 'Comeback Kid', description: 'Came back after a long break.', rarity: 'UNCOMMON', unlockRule: { type: 'ACHIEVEMENT', slug: 'comeback-kid' }, order: 11 },

  // --- Frames for streaks and a golden vouch --------------------------------------------------------
  { slug: 'frame-streak-7', type: 'FRAME', name: 'Ember', description: 'A 7 day streak.', rarity: 'COMMON', unlockRule: { type: 'STREAK', days: 7 }, order: 12 },
  { slug: 'frame-streak-30', type: 'FRAME', name: 'Blaze', description: 'A 30 day streak.', rarity: 'UNCOMMON', unlockRule: { type: 'STREAK', days: 30 }, order: 13 },
  { slug: 'frame-streak-100', type: 'FRAME', name: 'Inferno', description: 'A 100 day streak.', rarity: 'EPIC', unlockRule: { type: 'STREAK', days: 100 }, order: 14 },
  { slug: 'frame-streak-365', type: 'FRAME', name: 'Sun', description: 'A 365 day streak.', rarity: 'LEGENDARY', unlockRule: { type: 'STREAK', days: 365 }, order: 15 },
  { slug: 'frame-golden-vouch', type: 'FRAME', name: 'Gilded', description: 'Vouched for by a Gold builder.', rarity: 'RARE', unlockRule: { type: 'ACHIEVEMENT', slug: 'golden-vouch' }, order: 16 },

  // --- Banners for hackathon wins and shipping --------------------------------------------------------
  { slug: 'banner-first-win', type: 'BANNER', name: 'First Place', description: 'Won a hackathon.', rarity: 'UNCOMMON', unlockRule: { type: 'ACHIEVEMENT', slug: 'hackathon-winner' }, order: 17 },
  { slug: 'banner-champion', type: 'BANNER', name: 'Podium', description: 'Won 3 hackathons.', rarity: 'EPIC', unlockRule: { type: 'ACHIEVEMENT', slug: 'hackathon-champion' }, order: 18 },
  { slug: 'banner-legend', type: 'BANNER', name: 'Hall of Fame', description: 'Won 10 hackathons.', rarity: 'LEGENDARY', unlockRule: { type: 'ACHIEVEMENT', slug: 'hackathon-legend' }, order: 19 },
  { slug: 'banner-shipper', type: 'BANNER', name: 'Production Line', description: 'Shipped 25 projects.', rarity: 'RARE', unlockRule: { type: 'ACHIEVEMENT', slug: 'ship-25' }, order: 20 },
]

export const COSMETIC_BY_SLUG = new Map(COSMETIC_DEFINITIONS.map((cosmetic) => [cosmetic.slug, cosmetic]))

// --- Season rewards ------------------------------------------------------------------------------------------
// There is a new set for every season, so they are not in the list above: they are made from the season's number.

/** The awards in the order they are granted (and listed). */
export const SEASON_AWARDS: readonly SeasonAward[] = ['TOP_100', 'TOP_1_PERCENT', 'TOP_10_PERCENT', 'PARTICIPANT']

const SEASON_AWARD_PART: Record<SeasonAward, string> = {
  TOP_100: 'top-100',
  TOP_1_PERCENT: 'top-1-percent',
  TOP_10_PERCENT: 'top-10-percent',
  PARTICIPANT: 'participant',
}

export const seasonCosmeticSlug = (season: number, award: SeasonAward) => `season-${season}-${SEASON_AWARD_PART[award]}`

/** The cosmetic a season gives for `award`. The participation badge is worn in the badges slot (up to three are shown). */
export function seasonCosmetic(season: number, award: SeasonAward): CosmeticDefinition {
  const base = { slug: seasonCosmeticSlug(season, award), unlockRule: { type: 'SEASON', season, award } as UnlockRule, order: 1000 + season * 10 + SEASON_AWARDS.indexOf(award) }
  switch (award) {
    case 'TOP_100':
      return { ...base, type: 'TITLE', name: `Season ${season} Top 100`, description: `Finished in the top 100 of Season ${season}.`, rarity: 'EPIC' }
    case 'TOP_1_PERCENT':
      return { ...base, type: 'FRAME', name: `Season ${season} Top 1%`, description: `Finished in the top 1% of Season ${season}.`, rarity: 'LEGENDARY' }
    case 'TOP_10_PERCENT':
      return { ...base, type: 'FRAME', name: `Season ${season} Top 10%`, description: `Finished in the top 10% of Season ${season}.`, rarity: 'RARE' }
    case 'PARTICIPANT':
      return { ...base, type: 'BADGE', name: `Season ${season} Participant`, description: `Earned XP in Season ${season}.`, rarity: 'COMMON' }
  }
}

const SEASON_SLUG = /^season-([1-9]\d{0,5})-(top-100|top-1-percent|top-10-percent|participant)$/

/** The season and award a cosmetic slug stands for, or null when it is not a season cosmetic's slug. */
export function parseSeasonSlug(slug: string): { season: number; award: SeasonAward } | null {
  const match = SEASON_SLUG.exec(slug)
  if (!match) return null
  const award = SEASON_AWARDS.find((candidate) => SEASON_AWARD_PART[candidate] === match[2])
  return award ? { season: Number(match[1]), award } : null
}

/** A cosmetic by slug: one of the fixed ones, or a season's. Undefined for anything else. */
export function cosmeticDefinition(slug: string): CosmeticDefinition | undefined {
  const fixed = COSMETIC_BY_SLUG.get(slug)
  if (fixed) return fixed
  const season = parseSeasonSlug(slug)
  return season ? seasonCosmetic(season.season, season.award) : undefined
}

/**
 * How many places each award reaches in a season of `ranked` people: the top 100 (or everybody, in a smaller season),
 * and a percent of the field rounded up, so the winner of even a small season is in the top 1% and the top 10%.
 */
export function seasonAwardCutoffs(ranked: number): { TOP_100: number; TOP_1_PERCENT: number; TOP_10_PERCENT: number } {
  const count = Math.max(0, Math.trunc(ranked))
  return { TOP_100: Math.min(100, count), TOP_1_PERCENT: Math.ceil(count * 0.01), TOP_10_PERCENT: Math.ceil(count * 0.1) }
}

/** What happens to a person that can unlock cosmetics. */
export type UnlockTrigger =
  | { kind: 'TIER'; tier: Tier }
  | { kind: 'ACHIEVEMENT'; slug: string }
  | { kind: 'STREAK'; days: number }

const TIER_ORDER: Tier[] = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MYTHIC']

/** Whether `rule` is satisfied by `trigger`. A tier or a streak also satisfies every lower one, so nobody misses a title by skipping a tier. */
export function ruleMatches(rule: UnlockRule, trigger: UnlockTrigger): boolean {
  switch (rule.type) {
    case 'TIER':
      return trigger.kind === 'TIER' && TIER_ORDER.indexOf(trigger.tier) >= TIER_ORDER.indexOf(rule.tier)
    case 'ACHIEVEMENT':
      return trigger.kind === 'ACHIEVEMENT' && trigger.slug === rule.slug
    case 'STREAK':
      return trigger.kind === 'STREAK' && trigger.days >= rule.days
    case 'SEASON':
      // Granted when a season closes (src/lib/seasons.ts), never by something a person does.
      return false
  }
}

export const matchingCosmetics = (trigger: UnlockTrigger): CosmeticDefinition[] =>
  COSMETIC_DEFINITIONS.filter((cosmetic) => ruleMatches(cosmetic.unlockRule, trigger))

/** What a person has to do, in words, for the interface to show next to a locked cosmetic. */
export function requirementText(rule: UnlockRule): string {
  switch (rule.type) {
    case 'TIER':
      return `Reach the ${rule.tier.charAt(0)}${rule.tier.slice(1).toLowerCase()} tier`
    case 'ACHIEVEMENT':
      return `Unlock the achievement "${ACHIEVEMENT_DEFINITIONS[rule.slug].name}"`
    case 'STREAK':
      return `Keep a ${rule.days} day streak`
    case 'SEASON':
      return rule.award === 'PARTICIPANT' ? `Earn XP in Season ${rule.season}` : `Finish in the ${rule.award === 'TOP_100' ? 'top 100' : rule.award === 'TOP_1_PERCENT' ? 'top 1%' : 'top 10%'} of Season ${rule.season}`
  }
}
