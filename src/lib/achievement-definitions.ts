import type { Metric } from '@/lib/metrics'

// Single source of truth for the achievements: granted (and upserted by slug) by the progress engine
// in src/lib/achievement-progress.ts, listed by GET /api/achievements, and used by the demo seed.
//
// There are three kinds, told apart by `criteria`:
//  - a METRIC achievement unlocks when a counter reaches `target` (src/lib/metrics.ts). Several share a
//    metric to form a tiered series: ships 1 / 5 / 25 / 100. The first tier of each keeps the slug it
//    had before there were tiers;
//  - a STREAK achievement unlocks when the daily streak reaches `target` days;
//  - a SECRET achievement is unlocked by a rule on one event (`secret` names the rule) and is hidden
//    from everyone who has not earned it: its name, description and icon are masked in the API.
//
// Nothing here unlocks anything by itself: the criteria are descriptive for the interface and the rule
// engine is the only code that grants. Adding an achievement unlocks it for anyone whose counter
// already meets it the next time that counter moves (and never earlier).

export type SecretRule = 'night-owl-ship' | 'hat-trick' | 'clean-run' | 'gold-vouch' | 'weekend-shipper' | 'comeback'

export type AchievementCriteria =
  | { metric: Metric; target: number }
  | { metric: 'streak_days'; target: number }
  | { secret: SecretRule; target: 1 }

export interface AchievementDefinition {
  name: string
  description: string
  icon: string
  category: 'BUILDING' | 'HACKATHON' | 'TEAM' | 'REPUTATION' | 'STREAK' | 'SECRET'
  xpReward: number
  criteria: AchievementCriteria
  isSecret?: boolean
  order: number
}

export const ACHIEVEMENT_DEFINITIONS = {
  // --- Starting projects ------------------------------------------------------
  'first-project': {
    name: 'First Project',
    description: 'Created your first project.',
    icon: 'rocket',
    category: 'BUILDING',
    xpReward: 25,
    criteria: { metric: 'projects_created', target: 1 },
    order: 1,
  },
  'projects-10': {
    name: 'Idea Machine',
    description: 'Started 10 projects.',
    icon: 'lightbulb',
    category: 'BUILDING',
    xpReward: 50,
    criteria: { metric: 'projects_created', target: 10 },
    order: 2,
  },

  // --- Shipping -----------------------------------------------------------------
  'first-ship': {
    name: 'Shipped It',
    description: 'Shipped your first project.',
    icon: 'package-check',
    category: 'BUILDING',
    xpReward: 100,
    criteria: { metric: 'ships', target: 1 },
    order: 3,
  },
  'ship-5': {
    name: 'Shipping Habit',
    description: 'Shipped 5 projects.',
    icon: 'package-plus',
    category: 'BUILDING',
    xpReward: 100,
    criteria: { metric: 'ships', target: 5 },
    order: 4,
  },
  'ship-25': {
    name: 'Shipping Machine',
    description: 'Shipped 25 projects.',
    icon: 'factory',
    category: 'BUILDING',
    xpReward: 250,
    criteria: { metric: 'ships', target: 25 },
    order: 5,
  },
  'ship-100': {
    name: 'Centurion',
    description: 'Shipped 100 projects.',
    icon: 'medal',
    category: 'BUILDING',
    xpReward: 800,
    criteria: { metric: 'ships', target: 100 },
    order: 6,
  },

  // --- Project updates ------------------------------------------------------------
  'first-update': {
    name: 'Building in Public',
    description: 'Posted your first project update.',
    icon: 'megaphone',
    category: 'BUILDING',
    xpReward: 25,
    criteria: { metric: 'updates', target: 1 },
    order: 7,
  },
  'updates-25': {
    name: 'Regular Dispatch',
    description: 'Posted 25 project updates.',
    icon: 'newspaper',
    category: 'BUILDING',
    xpReward: 60,
    criteria: { metric: 'updates', target: 25 },
    order: 8,
  },
  'updates-100': {
    name: 'Chronicler',
    description: 'Posted 100 project updates.',
    icon: 'scroll-text',
    category: 'BUILDING',
    xpReward: 200,
    criteria: { metric: 'updates', target: 100 },
    order: 9,
  },

  // --- Milestones -----------------------------------------------------------------
  'first-milestone': {
    name: 'Milestone Reached',
    description: 'Completed your first project milestone.',
    icon: 'flag',
    category: 'BUILDING',
    xpReward: 50,
    criteria: { metric: 'milestones', target: 1 },
    order: 10,
  },
  'milestones-10': {
    name: 'Steady Progress',
    description: 'Completed 10 project milestones.',
    icon: 'list-checks',
    category: 'BUILDING',
    xpReward: 60,
    criteria: { metric: 'milestones', target: 10 },
    order: 11,
  },
  'milestones-50': {
    name: 'Milestone Master',
    description: 'Completed 50 project milestones.',
    icon: 'mountain',
    category: 'BUILDING',
    xpReward: 200,
    criteria: { metric: 'milestones', target: 50 },
    order: 12,
  },

  // --- Hackathons -----------------------------------------------------------------
  'first-hackathon': {
    name: 'Hackathon Rookie',
    description: 'Registered for your first hackathon.',
    icon: 'trophy',
    category: 'HACKATHON',
    xpReward: 25,
    criteria: { metric: 'hackathons_joined', target: 1 },
    order: 13,
  },
  'hackathons-5': {
    name: 'Hackathon Regular',
    description: 'Registered for 5 hackathons.',
    icon: 'calendar-check',
    category: 'HACKATHON',
    xpReward: 75,
    criteria: { metric: 'hackathons_joined', target: 5 },
    order: 14,
  },
  'hackathon-winner': {
    name: 'Hackathon Winner',
    description: "Placed 1st in a hackathon's final results.",
    icon: 'crown',
    category: 'HACKATHON',
    xpReward: 250,
    criteria: { metric: 'hackathon_wins', target: 1 },
    order: 15,
  },
  'hackathon-champion': {
    name: 'Hackathon Champion',
    description: 'Won 3 hackathons.',
    icon: 'award',
    category: 'HACKATHON',
    xpReward: 400,
    criteria: { metric: 'hackathon_wins', target: 3 },
    order: 16,
  },
  'hackathon-legend': {
    name: 'Hackathon Legend',
    description: 'Won 10 hackathons.',
    icon: 'gem',
    category: 'HACKATHON',
    xpReward: 1000,
    criteria: { metric: 'hackathon_wins', target: 10 },
    order: 17,
  },

  // --- Crews and teams --------------------------------------------------------------
  'team-builder': {
    name: 'Team Builder',
    description: 'Formed a crew for a hackathon.',
    icon: 'users',
    category: 'TEAM',
    xpReward: 25,
    criteria: { metric: 'crews_formed', target: 1 },
    order: 18,
  },
  'crews-5': {
    name: 'Crew Captain',
    description: 'Formed crews for 5 hackathons.',
    icon: 'ship',
    category: 'TEAM',
    xpReward: 75,
    criteria: { metric: 'crews_formed', target: 5 },
    order: 19,
  },
  'crews-15': {
    name: 'Crew Architect',
    description: 'Formed crews for 15 hackathons.',
    icon: 'network',
    category: 'TEAM',
    xpReward: 150,
    criteria: { metric: 'crews_formed', target: 15 },
    order: 20,
  },
  'team-player': {
    name: 'Team Player',
    description: 'Joined a team by having an application accepted.',
    icon: 'handshake',
    category: 'TEAM',
    xpReward: 25,
    criteria: { metric: 'teams_joined', target: 1 },
    order: 21,
  },
  'teams-5': {
    name: 'Familiar Face',
    description: 'Joined 5 teams.',
    icon: 'contact',
    category: 'TEAM',
    xpReward: 75,
    criteria: { metric: 'teams_joined', target: 5 },
    order: 22,
  },

  // --- Evidence ----------------------------------------------------------------------
  'first-evidence': {
    name: 'Show Your Work',
    description: 'Attached your first piece of evidence to a skill.',
    icon: 'badge-check',
    category: 'REPUTATION',
    xpReward: 25,
    criteria: { metric: 'evidence_added', target: 1 },
    order: 23,
  },
  'evidence-10': {
    name: 'Portfolio Builder',
    description: 'Attached 10 pieces of evidence to your skills.',
    icon: 'folder-check',
    category: 'REPUTATION',
    xpReward: 75,
    criteria: { metric: 'evidence_added', target: 10 },
    order: 24,
  },

  // --- Endorsements received -----------------------------------------------------------
  endorsed: {
    name: 'Vouched For',
    description: 'Had your work endorsed by another builder.',
    icon: 'thumbs-up',
    category: 'REPUTATION',
    xpReward: 50,
    criteria: { metric: 'endorsements_received', target: 1 },
    order: 25,
  },
  'endorsed-10': {
    name: 'Well Vouched',
    description: 'Had your work endorsed 10 times.',
    icon: 'shield-check',
    category: 'REPUTATION',
    xpReward: 75,
    criteria: { metric: 'endorsements_received', target: 10 },
    order: 26,
  },
  'endorsed-50': {
    name: 'Pillar of the Community',
    description: 'Had your work endorsed 50 times.',
    icon: 'landmark',
    category: 'REPUTATION',
    xpReward: 300,
    criteria: { metric: 'endorsements_received', target: 50 },
    order: 27,
  },

  // --- Endorsements given ----------------------------------------------------------------
  'endorser-1': {
    name: 'Vouch',
    description: "Endorsed another builder's work.",
    icon: 'hand-heart',
    category: 'REPUTATION',
    xpReward: 25,
    criteria: { metric: 'endorsements_given', target: 1 },
    order: 28,
  },
  'endorser-10': {
    name: 'Trusted Voice',
    description: "Endorsed 10 builders' work.",
    icon: 'message-circle-heart',
    category: 'REPUTATION',
    xpReward: 60,
    criteria: { metric: 'endorsements_given', target: 10 },
    order: 29,
  },
  'endorser-50': {
    name: 'Kingmaker',
    description: "Endorsed 50 builders' work.",
    icon: 'sparkles',
    category: 'REPUTATION',
    xpReward: 250,
    criteria: { metric: 'endorsements_given', target: 50 },
    order: 30,
  },

  // --- Streaks ---------------------------------------------------------------------------
  'streak-7': {
    name: 'Week Warrior',
    description: 'Built something 7 days in a row.',
    icon: 'flame',
    category: 'STREAK',
    xpReward: 40,
    criteria: { metric: 'streak_days', target: 7 },
    order: 31,
  },
  'streak-30': {
    name: 'Month of Momentum',
    description: 'Built something 30 days in a row.',
    icon: 'flame-kindling',
    category: 'STREAK',
    xpReward: 120,
    criteria: { metric: 'streak_days', target: 30 },
    order: 32,
  },
  'streak-100': {
    name: 'Hundred Days',
    description: 'Built something 100 days in a row.',
    icon: 'zap',
    category: 'STREAK',
    xpReward: 400,
    criteria: { metric: 'streak_days', target: 100 },
    order: 33,
  },
  'streak-365': {
    name: 'Year of Building',
    description: 'Built something 365 days in a row.',
    icon: 'sun',
    category: 'STREAK',
    xpReward: 1500,
    criteria: { metric: 'streak_days', target: 365 },
    order: 34,
  },

  // --- Secret ------------------------------------------------------------------------------
  'night-owl': {
    name: 'Night Owl',
    description: 'Shipped a project between 2 and 5 in the morning, your time.',
    icon: 'moon-star',
    category: 'SECRET',
    xpReward: 75,
    criteria: { secret: 'night-owl-ship', target: 1 },
    isSecret: true,
    order: 35,
  },
  'hat-trick': {
    name: 'Hat Trick',
    description: 'Shipped 3 projects in one week.',
    icon: 'layers',
    category: 'SECRET',
    xpReward: 100,
    criteria: { secret: 'hat-trick', target: 1 },
    isSecret: true,
    order: 36,
  },
  'no-safety-net': {
    name: 'No Safety Net',
    description: 'Reached a 30 day streak without spending a freeze.',
    icon: 'tightrope',
    category: 'SECRET',
    xpReward: 200,
    criteria: { secret: 'clean-run', target: 1 },
    isSecret: true,
    order: 37,
  },
  'golden-vouch': {
    name: 'Golden Vouch',
    description: 'Received an endorsement from a Gold builder or higher.',
    icon: 'star',
    category: 'SECRET',
    xpReward: 75,
    criteria: { secret: 'gold-vouch', target: 1 },
    isSecret: true,
    order: 38,
  },
  'weekend-warrior': {
    name: 'Weekend Warrior',
    description: 'Shipped on the weekend after shipping during the week.',
    icon: 'calendar-heart',
    category: 'SECRET',
    xpReward: 75,
    criteria: { secret: 'weekend-shipper', target: 1 },
    isSecret: true,
    order: 39,
  },
  'comeback-kid': {
    name: 'Comeback Kid',
    description: 'Came back and earned XP after more than 30 days away.',
    icon: 'undo-2',
    category: 'SECRET',
    xpReward: 50,
    criteria: { secret: 'comeback', target: 1 },
    isSecret: true,
    order: 40,
  },

  // --- Matching ---------------------------------------------------------------------
  // A spark and a match pay no XP themselves (a conversation is not worth farming), but these three milestones are one-time awards, so they pay a
  // small one-off amount that cannot be farmed: each can be earned once per person, and only for matches with a trusted account (src/lib/trust.ts).
  // A romance match counts for none of them (src/lib/matching/sparks.ts).
  'first-match': {
    name: 'First Match',
    description: 'Matched with another builder.',
    icon: 'handshake',
    category: 'TEAM',
    xpReward: 25,
    criteria: { metric: 'matches', target: 1 },
    order: 41,
  },
  'matches-10': {
    name: 'Well Matched',
    description: 'Matched with 10 builders.',
    icon: 'users',
    category: 'TEAM',
    xpReward: 50,
    criteria: { metric: 'matches', target: 10 },
    order: 42,
  },
  'match-teamed': {
    name: 'Better Together',
    description: 'Formed a team with someone you matched with.',
    icon: 'link',
    category: 'TEAM',
    xpReward: 100,
    criteria: { metric: 'match_teams', target: 1 },
    order: 43,
  },

  // --- Props ---------------------------------------------------------------------
  // Counted only for Props from trusted accounts (src/lib/trust.ts), once per post and giver.
  'props-10': {
    name: 'Respected',
    description: 'Received Props from 10 builders.',
    icon: 'thumbs-up',
    category: 'REPUTATION',
    xpReward: 20,
    criteria: { metric: 'props_received', target: 10 },
    order: 44,
  },
  'props-100': {
    name: 'Well Respected',
    description: 'Received Props from 100 builders.',
    icon: 'award',
    category: 'REPUTATION',
    xpReward: 60,
    criteria: { metric: 'props_received', target: 100 },
    order: 45,
  },

  // --- Ship Day ------------------------------------------------------------------
  // A post on the author's own Friday counts once per Ship Day (src/lib/ship-day.ts), however many are made, so these cannot be farmed.
  'ship-day-1': {
    name: 'Friday Shipper',
    description: 'Posted on a Ship Day.',
    icon: 'calendar-check',
    category: 'BUILDING',
    xpReward: 15,
    criteria: { metric: 'ship_day_posts', target: 1 },
    order: 46,
  },
  'ship-day-10': {
    name: 'Ship Day Regular',
    description: 'Posted on 10 Ship Days.',
    icon: 'calendar-heart',
    category: 'BUILDING',
    xpReward: 90,
    criteria: { metric: 'ship_day_posts', target: 10 },
    order: 47,
  },
} satisfies Record<string, AchievementDefinition>

export type AchievementSlug = keyof typeof ACHIEVEMENT_DEFINITIONS
export const ACHIEVEMENT_SLUGS = Object.keys(ACHIEVEMENT_DEFINITIONS) as AchievementSlug[]

/** The metric achievements (a counter reaching a target, or a streak), by what they count, lowest target first. */
export function achievementSeries(metric: Metric | 'streak_days'): { slug: AchievementSlug; target: number }[] {
  return ACHIEVEMENT_SLUGS.flatMap((slug) => {
    const criteria: AchievementCriteria = ACHIEVEMENT_DEFINITIONS[slug].criteria
    return 'metric' in criteria && criteria.metric === metric ? [{ slug, target: criteria.target }] : []
  }).sort((a, b) => a.target - b.target)
}

export function isSecretAchievement(slug: AchievementSlug): boolean {
  return Boolean((ACHIEVEMENT_DEFINITIONS[slug] as AchievementDefinition).isSecret)
}
