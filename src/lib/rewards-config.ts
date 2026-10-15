import type { DomainEventName, DomainEvents } from '@/lib/events'
import type { AchievementSlug } from '@/lib/achievement-definitions'

// Everything that decides how much XP an action is worth and how often it can be
// earned, in one table, so the amounts can be tuned without touching a route.
// docs/GAMIFICATION.md is the readable version of this file.

export type RewardAction = 'PROJECT_CREATED' | 'PROJECT_SHIP' | 'HACKATHON_JOIN' | 'TEAM_FORMED' | 'HACKATHON_WIN' | 'ACHIEVEMENT_EARNED'

/** What an award is attached to. Together with the action it decides what counts as "the same award". */
export type RewardSourceType = 'PROJECT' | 'HACKATHON' | 'ACHIEVEMENT'

export interface RewardRule {
  /** XP per award. Null when the source carries it (an achievement defines its own xpReward). */
  amount: number | null
  /** The kind of thing the award is for. grant() refuses any other kind. */
  sourceType: RewardSourceType
  /**
   * The one-time rule: a user earns this action at most once per source. It is
   * enforced by the unique index on XPEvent (userId, type, dedupeKey), so
   * retries and concurrent requests cannot pay twice.
   */
  oncePer: 'source'
  /** Most awards of this action per local calendar day of the user. Null: no cap. */
  dailyCap: number | null
}

export const REWARD_RULES: Record<RewardAction, RewardRule> = {
  // Once per project, at most 3 a day: creating and deleting projects in a loop stops paying after the third.
  PROJECT_CREATED: { amount: 50, sourceType: 'PROJECT', oncePer: 'source', dailyCap: 3 },
  // Once per project ever (shippedAt is the gate, see canAwardShipXp). The cap stops a create-ship-delete loop.
  PROJECT_SHIP: { amount: 200, sourceType: 'PROJECT', oncePer: 'source', dailyCap: 3 },
  HACKATHON_JOIN: { amount: 100, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null },
  TEAM_FORMED: { amount: 50, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null },
  HACKATHON_WIN: { amount: 500, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null },
  // Once per achievement, which UserAchievement also guarantees. The amount is the achievement's xpReward.
  ACHIEVEMENT_EARNED: { amount: null, sourceType: 'ACHIEVEMENT', oncePer: 'source', dailyCap: null },
}

export const REWARD_ACTIONS = Object.keys(REWARD_RULES) as RewardAction[]

export interface RewardSource {
  sourceType: RewardSourceType
  sourceId: string
}

/** "project:abc", "achievement:first-ship": stable, readable, and what the migration backfilled. */
export function dedupeKeyFor(source: RewardSource): string {
  return `${source.sourceType.toLowerCase()}:${source.sourceId}`
}

interface EventReward<N extends DomainEventName> {
  xp?: {
    action: RewardAction
    source: (payload: DomainEvents[N]) => RewardSource
    description: (payload: DomainEvents[N]) => string
  }
  achievement?: AchievementSlug
}

/** What each domain event pays out. An event that is absent here, or empty, is announced but pays nothing. */
export const EVENT_REWARDS: { [N in DomainEventName]: EventReward<N> } = {
  PROJECT_CREATED: {
    xp: {
      action: 'PROJECT_CREATED',
      source: (p) => ({ sourceType: 'PROJECT', sourceId: p.projectId }),
      description: (p) => `Created project "${p.projectName}"`,
    },
    achievement: 'first-project',
  },
  PROJECT_SHIPPED: {
    xp: {
      action: 'PROJECT_SHIP',
      source: (p) => ({ sourceType: 'PROJECT', sourceId: p.projectId }),
      description: (p) => `Shipped project "${p.projectName}"`,
    },
    achievement: 'first-ship',
  },
  PROJECT_UPDATE_POSTED: { achievement: 'first-update' },
  MILESTONE_COMPLETED: { achievement: 'first-milestone' },
  HACKATHON_JOINED: {
    xp: {
      action: 'HACKATHON_JOIN',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Joined hackathon "${p.hackathonName}"`,
    },
    achievement: 'first-hackathon',
  },
  HACKATHON_WON: {
    xp: {
      action: 'HACKATHON_WIN',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Won "${p.hackathonName}"`,
    },
    achievement: 'hackathon-winner',
  },
  TEAM_FORMED: {
    xp: {
      action: 'TEAM_FORMED',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Formed team for "${p.hackathonName}"`,
    },
    achievement: 'team-builder',
  },
  TEAM_APPLICATION_ACCEPTED: { achievement: 'team-player' },
  EVIDENCE_ADDED: { achievement: 'first-evidence' },
  // Gated by the endorsement rules in src/lib/skill-evidence.ts before it pays.
  EVIDENCE_ENDORSED: { achievement: 'endorsed' },
  CONNECTION_ACCEPTED: {},
  MESSAGE_SENT_FIRST_IN_CONNECTION: {},
}

/**
 * Ship XP and reputation are awarded exactly once per project, ever - not once
 * per SHIPPED transition. A project's `shippedAt` is only ever set the first
 * time it ships, so its presence is the one-time gate: cycling
 * SHIPPED -> BUILDING -> SHIPPED cannot re-trigger the award.
 */
export function canAwardShipXp(project: { status?: string | null; shippedAt: Date | null }, nextStatus: string | undefined): boolean {
  return nextStatus === 'SHIPPED' && !project.shippedAt
}
