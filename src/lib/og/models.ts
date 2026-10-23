// What a share card shows, as plain data. The privacy rules are applied when these are made (data.ts), so the drawing (layout.ts) has nothing private to leak: it can only
// print what is in the model.

export interface PassportCard {
  kind: 'passport'
  username: string
  /** Null for a name the fonts cannot draw. */
  name: string | null
  headline: string | null
  role: string | null
  skills: string[]
  level: number
  tier: string
  projectsShipped: number
  achievements: number
}

export interface PostCard {
  kind: 'post'
  title: string
  excerpt: string
  /** SHIP, UPDATE, DEVLOG or DEMO. */
  postKind: string
  author: string
  propsCount: number
  commentCount: number
}

export interface SquadCard {
  kind: 'squad'
  squad: string
  hackathon: string
  rank: number | null
  project: string | null
  memberCount: number
  /** Adults who are visible people. */
  members: string[]
  /** The members not named: minors, people who chose not to be found, accounts that are gone. */
  unnamed: number
}

export interface AchievementCard {
  kind: 'achievement'
  name: string
  description: string
  xp: number
  /** The share of builders who have it, 0 to 100, or null before the nightly job has measured it. */
  rarityPercent: number | null
  earnedOn: string
  holder: string
}

export type CardModel = PassportCard | PostCard | SquadCard | AchievementCard
