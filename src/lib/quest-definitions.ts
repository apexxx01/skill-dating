import type { Metric } from '@/lib/metrics'

// The quest pool. A quest is a small, useful thing to do inside a day or a week: ship something,
// write an update, vouch for a teammate, answer a message that is waiting on you. Every quest asks for a
// number of one counted action (src/lib/metrics.ts), and an action is only counted when it paid XP, so
// the pool cannot contain an engagement quest ("open the app", "visit a page"): there is no such action
// to ask for. src/lib/quest-definitions.test.ts checks that, and that nothing here depends on
// somebody else's decision (an application being accepted) or on luck (winning).
//
// Each person is given three daily and three weekly quests from this pool at a time (src/lib/quests.ts).
// A quest pays its `xpReward` once, when it is completed, as a QUEST_COMPLETED award; that XP is small
// next to the action behind it (the update that completes a daily quest already paid 15), because the
// point is to point people at useful work, not to be the reason to do it.

export type QuestType = 'DAILY' | 'WEEKLY'

/** The counted actions a quest may ask for: what a person can do on their own, whenever they like. */
export const QUEST_METRICS = [
  'projects_created',
  'ships',
  'milestones',
  'updates',
  'evidence_added',
  'endorsements_given',
  'connections',
  'first_messages',
  'replies',
  'hackathons_joined',
  'crews_formed',
  // Ready for a Ship Day quest; none is in the rotating pool yet, because adding one reshuffles everybody's current week (see quests.test.ts, which pins the picks).
  'ship_day_posts',
] as const satisfies readonly Metric[]
export type QuestMetric = (typeof QUEST_METRICS)[number]

export interface QuestDefinition {
  slug: string
  name: string
  description: string
  type: QuestType
  metric: QuestMetric
  target: number
  xpReward: number
}

const daily = (slug: string, name: string, description: string, metric: QuestMetric, target: number, xpReward: number): QuestDefinition => ({
  slug: `daily-${slug}`,
  name,
  description,
  type: 'DAILY',
  metric,
  target,
  xpReward,
})
const weekly = (slug: string, name: string, description: string, metric: QuestMetric, target: number, xpReward: number): QuestDefinition => ({
  slug: `weekly-${slug}`,
  name,
  description,
  type: 'WEEKLY',
  metric,
  target,
  xpReward,
})

export const DAILY_QUESTS: QuestDefinition[] = [
  daily('update-1', 'Share your progress', 'Post a project update.', 'updates', 1, 2),
  daily('update-2', 'Keep them posted', 'Post two project updates.', 'updates', 2, 4),
  daily('update-3', 'Narrate the build', 'Post three project updates.', 'updates', 3, 6),
  daily('milestone-1', 'Hit a milestone', 'Complete a project milestone.', 'milestones', 1, 3),
  daily('milestone-2', 'Two steps forward', 'Complete two project milestones.', 'milestones', 2, 4),
  daily('milestone-3', 'On a roll', 'Complete three project milestones.', 'milestones', 3, 6),
  daily('evidence-1', 'Show your work', 'Add evidence to a skill.', 'evidence_added', 1, 3),
  daily('evidence-2', 'Back it up', 'Add evidence to two of your skills.', 'evidence_added', 2, 4),
  daily('endorse-1', 'Vouch for a teammate', "Endorse another builder's work.", 'endorsements_given', 1, 2),
  daily('endorse-3', 'Spread the credit', "Endorse three builders' work.", 'endorsements_given', 3, 6),
  daily('connect-1', 'Welcome someone in', 'Accept a connection request.', 'connections', 1, 2),
  daily('connect-2', 'Grow your circle', 'Accept two connection requests.', 'connections', 2, 4),
  daily('message-1', 'Break the ice', 'Start a conversation with a new connection.', 'first_messages', 1, 2),
  daily('message-2', 'Say hello twice', 'Start conversations with two new connections.', 'first_messages', 2, 4),
  daily('reply-1', 'Answer the waiting message', 'Reply in a conversation that is waiting on you.', 'replies', 1, 2),
  daily('reply-2', 'Clear the backlog', 'Reply in two conversations that are waiting on you.', 'replies', 2, 4),
  daily('reply-3', 'Inbox hero', 'Reply in three conversations that are waiting on you.', 'replies', 3, 6),
  daily('ship-1', 'Ship it', 'Ship a project.', 'ships', 1, 9),
  daily('project-1', 'Start something', 'Create a new project.', 'projects_created', 1, 3),
  daily('project-2', 'Two ideas in motion', 'Create two new projects.', 'projects_created', 2, 4),
]

export const WEEKLY_QUESTS: QuestDefinition[] = [
  weekly('ship-1', 'Ship something this week', 'Ship a project.', 'ships', 1, 16),
  weekly('ship-2', 'Double ship', 'Ship two projects.', 'ships', 2, 29),
  weekly('update-5', 'Build in public', 'Post five project updates.', 'updates', 5, 11),
  weekly('milestone-5', 'Make real progress', 'Complete five project milestones.', 'milestones', 5, 14),
  weekly('milestone-10', 'Milestone sprint', 'Complete ten project milestones.', 'milestones', 10, 26),
  weekly('evidence-3', 'Build your proof', 'Add evidence to three skills.', 'evidence_added', 3, 11),
  weekly('endorse-5', 'Vouch for five', "Endorse five builders' work.", 'endorsements_given', 5, 11),
  weekly('connect-5', 'Meet five builders', 'Accept five connection requests.', 'connections', 5, 11),
  weekly('message-3', 'Start three conversations', 'Start conversations with three new connections.', 'first_messages', 3, 8),
  weekly('reply-5', 'Always answer', 'Reply in five conversations that were waiting on you.', 'replies', 5, 10),
  weekly('hackathon-1', 'Enter a hackathon', 'Register for a hackathon.', 'hackathons_joined', 1, 16),
  weekly('project-2', 'Two new projects', 'Create two new projects.', 'projects_created', 2, 11),
]

export const QUEST_DEFINITIONS: readonly QuestDefinition[] = [...DAILY_QUESTS, ...WEEKLY_QUESTS]

const BY_SLUG = new Map(QUEST_DEFINITIONS.map((quest) => [quest.slug, quest]))

export function questBySlug(slug: string): QuestDefinition | undefined {
  return BY_SLUG.get(slug)
}

export const QUEST_POOL: Record<QuestType, readonly QuestDefinition[]> = { DAILY: DAILY_QUESTS, WEEKLY: WEEKLY_QUESTS }

/** How many quests of each kind a person has at a time. */
export const QUESTS_PER_PERIOD = 3
