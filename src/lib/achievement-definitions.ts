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
} satisfies Record<string, AchievementDefinition>

export type AchievementSlug = keyof typeof ACHIEVEMENT_DEFINITIONS
