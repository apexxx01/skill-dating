// Single source of truth for achievement definitions, upserted by slug
// wherever they're granted (see grantAchievement) and by the demo seed.
// Adding a new achievement here does not retroactively grant it to anyone
// who already met the criteria — criteria are descriptive metadata only,
// not evaluated by any engine; grantAchievement is always called explicitly
// from the code path that satisfies the achievement.
export interface AchievementDefinition {
  name: string
  description: string
  icon: string
  category: string
  xpReward: number
  criteria: Record<string, unknown>
  isSecret?: boolean
  order: number
}

export const ACHIEVEMENT_DEFINITIONS = {
  'first-project': {
    name: 'First Project',
    description: 'Created your first project.',
    icon: 'rocket',
    category: 'BUILDING',
    xpReward: 25,
    criteria: { type: 'PROJECT_CREATED', count: 1 },
    order: 1,
  },
  'first-ship': {
    name: 'Shipped It',
    description: 'Shipped your first project.',
    icon: 'package-check',
    category: 'BUILDING',
    xpReward: 100,
    criteria: { type: 'PROJECT_SHIP', count: 1 },
    order: 2,
  },
  'first-hackathon': {
    name: 'Hackathon Rookie',
    description: 'Registered for your first hackathon.',
    icon: 'trophy',
    category: 'HACKATHON',
    xpReward: 25,
    criteria: { type: 'HACKATHON_JOIN', count: 1 },
    order: 3,
  },
  'team-builder': {
    name: 'Team Builder',
    description: 'Formed a team for a hackathon.',
    icon: 'users',
    category: 'TEAM',
    xpReward: 25,
    criteria: { type: 'TEAM_FORMED', count: 1 },
    order: 4,
  },
  'team-player': {
    name: 'Team Player',
    description: 'Joined a team by having an application accepted.',
    icon: 'handshake',
    category: 'TEAM',
    xpReward: 25,
    criteria: { type: 'TEAM_APPLICATION_ACCEPTED', count: 1 },
    order: 5,
  },
  'first-evidence': {
    name: 'Show Your Work',
    description: 'Attached your first piece of evidence to a skill.',
    icon: 'badge-check',
    category: 'REPUTATION',
    xpReward: 25,
    criteria: { type: 'SKILL_EVIDENCE_ADDED', count: 1 },
    order: 7,
  },
  endorsed: {
    name: 'Vouched For',
    description: 'Had your work endorsed by another builder.',
    icon: 'thumbs-up',
    category: 'REPUTATION',
    xpReward: 50,
    criteria: { type: 'SKILL_EVIDENCE_ENDORSED', count: 1 },
    order: 8,
  },
  'first-update': {
    name: 'Building in Public',
    description: 'Posted your first project update.',
    icon: 'megaphone',
    category: 'BUILDING',
    xpReward: 25,
    criteria: { type: 'PROJECT_UPDATE_POSTED', count: 1 },
    order: 9,
  },
  'first-milestone': {
    name: 'Milestone Reached',
    description: 'Completed your first project milestone.',
    icon: 'flag',
    category: 'BUILDING',
    xpReward: 50,
    criteria: { type: 'MILESTONE_COMPLETED', count: 1 },
    order: 10,
  },
  'hackathon-winner': {
    name: 'Hackathon Winner',
    description: "Placed 1st in a hackathon's final results.",
    icon: 'crown',
    category: 'HACKATHON',
    xpReward: 250,
    criteria: { type: 'HACKATHON_WIN', rank: 1 },
    order: 6,
  },
} satisfies Record<string, AchievementDefinition>

export type AchievementSlug = keyof typeof ACHIEVEMENT_DEFINITIONS
