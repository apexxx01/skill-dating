import type { DomainEventName, DomainEvents } from '@/lib/events'

// Everything that decides how much XP an action is worth and how often it can be
// earned, in one table, so the amounts can be tuned without touching a route.
// docs/GAMIFICATION.md is the readable version of this file.

export type RewardAction =
  | 'PROJECT_CREATED'
  | 'PROJECT_SHIP'
  | 'HACKATHON_JOIN'
  | 'TEAM_FORMED'
  | 'HACKATHON_WIN'
  | 'ACHIEVEMENT_EARNED'
  | 'MILESTONE_COMPLETED'
  | 'PROJECT_UPDATE_POSTED'
  | 'EVIDENCE_ADDED'
  | 'EVIDENCE_ENDORSED'
  | 'CONNECTION_ACCEPTED'
  | 'MESSAGE_SENT_FIRST_IN_CONNECTION'
  | 'TEAM_APPLICATION_ACCEPTED'
  | 'QUEST_COMPLETED'
  | 'PROPS_RECEIVED'
  | 'SQUAD_SLOT_FILLED'
  | 'SQUAD_SUBMITTED'
  | 'SQUAD_JOIN_CONFIRMED'
  | 'INVITE_QUALIFIED'

/** What an award is attached to. Together with the action it decides what counts as "the same award". */
export type RewardSourceType =
  | 'PROJECT'
  | 'HACKATHON'
  | 'ACHIEVEMENT'
  | 'MILESTONE'
  | 'PROJECT_UPDATE'
  | 'EVIDENCE'
  | 'ENDORSEMENT'
  | 'CONNECTION'
  | 'CONVERSATION'
  | 'TEAM_APPLICATION'
  | 'QUEST'
  | 'PROP'
  | 'TEAM_SLOT'
  | 'INVITE'

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
  /**
   * Whether an award counts as an action of the user's own for their streak. False for what other
   * people give them (endorsements, an accepted application, a win recorded by an organiser) and
   * for rewards that only exist because of an earlier one (an achievement), so a streak cannot be
   * kept alive by someone else, or by a reward that is itself paid for doing nothing that day.
   */
  streak: boolean
}

export const REWARD_RULES: Record<RewardAction, RewardRule> = {
  // Once per project, at most 3 a day: creating and deleting projects in a loop stops paying after the third.
  PROJECT_CREATED: { amount: 50, sourceType: 'PROJECT', oncePer: 'source', dailyCap: 3, streak: true },
  // Once per project ever (shippedAt is the gate, see canAwardShipXp). The cap stops a create-ship-delete loop.
  PROJECT_SHIP: { amount: 200, sourceType: 'PROJECT', oncePer: 'source', dailyCap: 3, streak: true },
  HACKATHON_JOIN: { amount: 100, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null, streak: true },
  TEAM_FORMED: { amount: 50, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null, streak: true },
  HACKATHON_WIN: { amount: 500, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null, streak: false },
  // Once per achievement, which UserAchievement also guarantees. The amount is the achievement's xpReward.
  ACHIEVEMENT_EARNED: { amount: null, sourceType: 'ACHIEVEMENT', oncePer: 'source', dailyCap: null, streak: false },
  // Once per milestone (completing, reopening and completing again pays once), at most 5 a day.
  MILESTONE_COMPLETED: { amount: 30, sourceType: 'MILESTONE', oncePer: 'source', dailyCap: 5, streak: true },
  // Every update is its own source, so the cap is what limits posting for XP.
  PROJECT_UPDATE_POSTED: { amount: 15, sourceType: 'PROJECT_UPDATE', oncePer: 'source', dailyCap: 3, streak: true },
  // Once per piece of evidence, at most 3 a day.
  EVIDENCE_ADDED: { amount: 20, sourceType: 'EVIDENCE', oncePer: 'source', dailyCap: 3, streak: true },
  // Paid to the owner of the evidence, once per (evidence, endorser) pair, at most 10 a day.
  EVIDENCE_ENDORSED: { amount: 10, sourceType: 'ENDORSEMENT', oncePer: 'source', dailyCap: 10, streak: false },
  // Paid to both people, once per connection, at most 5 a day each.
  CONNECTION_ACCEPTED: { amount: 10, sourceType: 'CONNECTION', oncePer: 'source', dailyCap: 5, streak: true },
  // Paid to the sender, once per conversation, at most 5 a day.
  MESSAGE_SENT_FIRST_IN_CONNECTION: { amount: 5, sourceType: 'CONVERSATION', oncePer: 'source', dailyCap: 5, streak: true },
  // Paid to the applicant, once per application, at most 3 a day. Only when the other side of the acceptance is a trusted
  // counterparty and the applicant's own account is too (src/lib/trust.ts): two throwaway accounts could otherwise apply to and accept each other.
  TEAM_APPLICATION_ACCEPTED: { amount: 50, sourceType: 'TEAM_APPLICATION', oncePer: 'source', dailyCap: 3, streak: false },
  // Once per quest and period (the source is the UserQuest). The amount is the quest's own xpReward, and
  // a person has at most three daily and three weekly quests at a time, which is the cap.
  QUEST_COMPLETED: { amount: null, sourceType: 'QUEST', oncePer: 'source', dailyCap: null, streak: false },
  // Paid to the author of a post, once per (post, giver) pair, at most 20 a day. Small on purpose, and only when the giver is a trusted counterparty (src/lib/trust.ts): respect is
  // not something two throwaway accounts can mint for each other. A Prop from an account the gate does not trust is recorded with weight 0 and pays nothing.
  PROPS_RECEIVED: { amount: 2, sourceType: 'PROP', oncePer: 'source', dailyCap: 20, streak: false },
  // Squads (docs/SQUADS.md). Paid to the owner once per slot, at most 5 a day, and only when the person who filled it is a trusted counterparty.
  SQUAD_SLOT_FILLED: { amount: 15, sourceType: 'TEAM_SLOT', oncePer: 'source', dailyCap: 5, streak: false },
  // Each member of a squad that submitted, once per hackathon.
  SQUAD_SUBMITTED: { amount: 75, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null, streak: true },
  // Joining someone else's squad that later submitted, once per hackathon, when the squad's owner is a trusted counterparty.
  SQUAD_JOIN_CONFIRMED: { amount: 30, sourceType: 'HACKATHON', oncePer: 'source', dailyCap: null, streak: false },
  // Paid to the inviter, once per invitee, when the invitee has finished onboarding and done a first real thing (src/lib/invites), at most 3 a day, and only while the invitee is a trusted
  // counterparty (src/lib/trust.ts). The lifetime cap (INVITE_REWARD_CAP) is enforced by the invite job before it asks.
  INVITE_QUALIFIED: { amount: 40, sourceType: 'INVITE', oncePer: 'source', dailyCap: 3, streak: false },
}

export const REWARD_ACTIONS = Object.keys(REWARD_RULES) as RewardAction[]

/**
 * XP that is paid because of an earlier reward rather than for something the user did: it adds to a
 * day's XP in the heatmap but is not counted as an action.
 */
export const DERIVED_XP_TYPES: readonly string[] = ['ACHIEVEMENT_EARNED', 'QUEST_COMPLETED']

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
    /** Who is paid. Absent: the event's `userId`. */
    recipients?: (payload: DomainEvents[N]) => string[]
  }
}

/** What each domain event pays out. An event that is absent here, or empty, is announced but pays nothing. */
export const EVENT_REWARDS: { [N in DomainEventName]: EventReward<N> } = {
  PROJECT_CREATED: {
    xp: {
      action: 'PROJECT_CREATED',
      source: (p) => ({ sourceType: 'PROJECT', sourceId: p.projectId }),
      description: (p) => `Created project "${p.projectName}"`,
    },
  },
  PROJECT_SHIPPED: {
    xp: {
      action: 'PROJECT_SHIP',
      source: (p) => ({ sourceType: 'PROJECT', sourceId: p.projectId }),
      description: (p) => `Shipped project "${p.projectName}"`,
    },
  },
  PROJECT_UPDATE_POSTED: {
    xp: {
      action: 'PROJECT_UPDATE_POSTED',
      source: (p) => ({ sourceType: 'PROJECT_UPDATE', sourceId: p.updateId }),
      description: () => 'Posted a project update',
    },
  },
  MILESTONE_COMPLETED: {
    xp: {
      action: 'MILESTONE_COMPLETED',
      source: (p) => ({ sourceType: 'MILESTONE', sourceId: p.milestoneId }),
      description: () => 'Completed a project milestone',
    },
  },
  HACKATHON_JOINED: {
    xp: {
      action: 'HACKATHON_JOIN',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Joined hackathon "${p.hackathonName}"`,
    },
  },
  HACKATHON_WON: {
    xp: {
      action: 'HACKATHON_WIN',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Won "${p.hackathonName}"`,
    },
  },
  TEAM_FORMED: {
    xp: {
      action: 'TEAM_FORMED',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Formed team for "${p.hackathonName}"`,
    },
  },
  TEAM_APPLICATION_ACCEPTED: {
    xp: {
      action: 'TEAM_APPLICATION_ACCEPTED',
      source: (p) => ({ sourceType: 'TEAM_APPLICATION', sourceId: p.applicationId }),
      description: () => 'Had a team application accepted',
    },
  },
  EVIDENCE_ADDED: {
    xp: {
      action: 'EVIDENCE_ADDED',
      source: (p) => ({ sourceType: 'EVIDENCE', sourceId: p.evidenceId }),
      description: () => 'Added evidence to a skill',
    },
  },
  // Gated by the endorsement rules in src/lib/skill-evidence.ts before it pays, XP and achievement alike.
  EVIDENCE_ENDORSED: {
    xp: {
      action: 'EVIDENCE_ENDORSED',
      source: (p) => ({ sourceType: 'ENDORSEMENT', sourceId: `${p.evidenceId}:${p.endorserId}` }),
      description: () => 'Had evidence endorsed',
    },
  },
  CONNECTION_ACCEPTED: {
    xp: {
      action: 'CONNECTION_ACCEPTED',
      source: (p) => ({ sourceType: 'CONNECTION', sourceId: p.connectionId }),
      description: () => 'Made a new connection',
      recipients: (p) => [p.userId, p.otherUserId],
    },
  },
  MESSAGE_SENT_FIRST_IN_CONNECTION: {
    xp: {
      action: 'MESSAGE_SENT_FIRST_IN_CONNECTION',
      source: (p) => ({ sourceType: 'CONVERSATION', sourceId: p.conversationId }),
      description: () => 'Started a conversation with a connection',
    },
  },
  // Announced by the rewards engine itself. They pay nothing of their own; achievements and quests listen.
  STREAK_EXTENDED: {},
  USER_COMEBACK: {},
  MESSAGE_REPLIED: {},
  ACHIEVEMENT_UNLOCKED: {},
  TIER_REACHED: {},
  PROPS_RECEIVED: {
    xp: {
      action: 'PROPS_RECEIVED',
      source: (p) => ({ sourceType: 'PROP', sourceId: `${p.postId}:${p.giverId}` }),
      description: () => 'Received Props on a post',
    },
  },
  // Pays nothing; counts once per Ship Day.
  POST_SHIP_DAY: {},
  // Sparks and matches pay no XP, on purpose: nothing about starting conversations is worth farming.
  MATCH_CREATED: {},
  MATCH_TEAM_FORMED: {},
  SQUAD_SLOT_FILLED: {
    xp: {
      action: 'SQUAD_SLOT_FILLED',
      source: (p) => ({ sourceType: 'TEAM_SLOT', sourceId: p.slotId }),
      description: () => 'Filled a slot on your squad',
    },
  },
  SQUAD_SUBMITTED: {
    xp: {
      action: 'SQUAD_SUBMITTED',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Submitted with your squad to "${p.hackathonName}"`,
    },
  },
  SQUAD_JOIN_CONFIRMED: {
    xp: {
      action: 'SQUAD_JOIN_CONFIRMED',
      source: (p) => ({ sourceType: 'HACKATHON', sourceId: p.hackathonId }),
      description: (p) => `Joined a squad that submitted to "${p.hackathonName}"`,
    },
  },
  // Pay nothing; they count toward the squad achievements.
  AUTO_SQUAD_FORMED: {},
  SQUAD_REUNITED: {},
  INVITE_QUALIFIED: {
    xp: {
      action: 'INVITE_QUALIFIED',
      source: (p) => ({ sourceType: 'INVITE', sourceId: p.redemptionId }),
      description: () => 'Someone you invited got started',
    },
  },
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
