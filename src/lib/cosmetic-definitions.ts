import { ACHIEVEMENT_DEFINITIONS, type AchievementSlug } from '@/lib/achievement-definitions'
import type { Tier } from '@/lib/levels'

// The cosmetics: titles, frames and banners for a profile. They are EARNED and only earned: each has an
// unlock rule, and src/lib/cosmetics.ts grants one only when something that happens to a person matches it.
// There is no price, no purchase and no route that hands one out (a test checks all three).
//
//  - TIER: reaching a tier (or any higher one, so a person who is already Gold also gets the Silver title);
//  - ACHIEVEMENT: unlocking an achievement;
//  - STREAK: a daily streak of that many days (or more).

export type CosmeticType = 'TITLE' | 'FRAME' | 'BANNER' | 'AVATAR_PART'
export type CosmeticRarity = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY'

export type UnlockRule =
  | { type: 'TIER'; tier: Tier }
  | { type: 'ACHIEVEMENT'; slug: AchievementSlug }
  | { type: 'STREAK'; days: number }

export interface CosmeticDefinition {
  slug: string
  type: CosmeticType
  name: string
  description: string
  rarity: CosmeticRarity
  unlockRule: UnlockRule
  order: number
}

/** Which slot of `User.equipped` a type goes in. Avatar parts have no slot yet. */
export const SLOT_OF: Record<CosmeticType, 'title' | 'frame' | 'banner' | null> = {
  TITLE: 'title',
  FRAME: 'frame',
  BANNER: 'banner',
  AVATAR_PART: null,
}

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
  }
}
