// Response types for the HTTP API, for the interface to import. They describe
// the JSON exactly as it arrives over the wire, so every date is an ISO
// string, not a Date. Nothing here has a runtime; it is types only.
//
// docs/FRONTEND_CONTRACT.md says which page should call which endpoint and
// where the old mock data differs from what the API returns. The integration
// test tests/integration/frontend-contract.test.ts fetches each of these
// shapes from a running server and fails if a promised field disappears.

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/**
 * Every non-2xx response has this shape. Branch on `code` (the full list is
 * ERROR_CATALOG in src/lib/api/errors.ts); `message` is an English default and
 * not stable. `params` holds the values the message interpolates, so another
 * language can be rendered from `code` and `params`.
 */
export interface ApiError {
  error: {
    code: string
    message: string
    params?: Record<string, string | number | boolean>
    /** Structured extra data, e.g. `{ field: string[] }` for VALIDATION_FAILED. */
    details?: unknown
  }
}

/** Rate limited (429, RATE_LIMITED, `params.retryAfter` in seconds) and unavailable (503) responses. */
export type RateLimitedError = ApiError

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

/**
 * Every list endpoint takes `limit` and either `page` or `cursor`, and answers
 * with `nextCursor`. A cursor is opaque: pass it back unchanged. A request with a
 * `cursor` runs no count, so its answer has no `pagination`. Lists that are a bare
 * JSON array (`GET /api/users/{id}/skills`, `GET /api/teams/{id}/applications`)
 * send the next cursor in the `X-Next-Cursor` response header instead.
 */
export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
  pagination?: Pagination
}

export type IsoDate = string

export interface UserSummary {
  id: string
  name: string | null
  username: string | null
  image: string | null
}

export interface UserWithHeadline extends UserSummary {
  headline: string | null
}

export interface UserWithRole extends UserSummary {
  builderRole: string | null
}

export interface SkillSummary {
  id: string
  name: string
  slug: string
  category: string
  color?: string | null
  icon?: string | null
}

/** A user's skill: the UserSkill row with its skill attached. */
export interface UserSkillEntry {
  id: string
  userId: string
  skillId: string
  level: number
  yearsExperience: number | null
  isVerified: boolean
  skill: SkillSummary
}

export type ProjectStatus = 'IDEA' | 'PLANNING' | 'BUILDING' | 'TESTING' | 'SHIPPED' | 'ARCHIVED'
export type HackathonStatus = 'UPCOMING' | 'ACTIVE' | 'ENDED' | 'CANCELLED'
export type ConversationType = 'DIRECT' | 'GROUP' | 'PROJECT' | 'TEAM' | 'HACKATHON'
export type ConnectionType = 'TEAMMATE' | 'COLLABORATOR' | 'MENTOR' | 'FRIEND' | 'NETWORK' | 'DATING'
export type TeamRole = 'OWNER' | 'ADMIN' | 'MEMBER'

// ---------------------------------------------------------------------------
// Discover, users, profile
// ---------------------------------------------------------------------------

/** One builder in GET /api/discover. `rank` is a stored column that is never updated: do not show it here. */
export interface DiscoverPerson extends UserWithHeadline {
  location: string | null
  builderRole: string | null
  xp: number
  rank: number
  reputationScore: number
  githubUsername: string | null
  createdAt: IsoDate
  skills: UserSkillEntry[]
  /** 0-100, computed against the signed-in user. */
  compatibility: number
}

export interface DiscoverResponse {
  people: DiscoverPerson[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export type UserListItem = Omit<DiscoverPerson, 'compatibility'>

export interface UsersResponse {
  users: UserListItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface AchievementDefinition {
  id: string
  name: string
  slug: string
  description: string
  icon: string | null
  category: string
  xpReward: number
  isSecret: boolean
}

/**
 * One achievement as GET /api/achievements and GET /api/users/{id}/achievements list it: the whole
 * catalog, in `order`, with this user's standing in each. A secret achievement the user has not earned
 * is `masked`: its text, icon, reward, progress and rarity are null and its `slug` is a placeholder
 * (`secret-<order>`), so nothing gives the rule away. Once earned it is listed like any other.
 */
export interface AchievementItem {
  slug: string
  name: string
  description: string
  icon: string | null
  category: 'BUILDING' | 'HACKATHON' | 'TEAM' | 'REPUTATION' | 'STREAK' | 'SECRET'
  /** XP unlocking it pays. Null while it is masked. */
  xpReward: number | null
  secret: boolean
  masked: boolean
  earned: boolean
  earnedAt: IsoDate | null
  /** How far along: `current` counts up to `target`. Full once earned. Null while masked. */
  progress: { current: number; target: number } | null
  /** The share of users active in the last 30 days who have it, 0 to 1 (smaller is rarer). Null until the nightly job has run, and while masked. */
  rarity: number | null
  order: number
}

export interface AchievementsResponse {
  achievements: AchievementItem[]
  earned: number
  total: number
}

export interface EarnedAchievement {
  id: string
  earnedAt: IsoDate
  achievement: AchievementDefinition
}

export interface ProjectRef {
  id: string
  name: string
  slug: string
  status: ProjectStatus
  thumbnail?: string | null
  techStack?: string[]
}

export interface TeamRef {
  id: string
  name: string
  slug: string
  isRecruiting: boolean
  maxSize: number
  project: { id: string; name: string; slug: string; status: ProjectStatus } | null
  _count: { members: number; applications: number }
}

/** GET /api/users/[id]. `email` is present only when you request your own profile. */
export interface ProfileResponse extends UserWithHeadline {
  email?: string
  bio: string | null
  location: string | null
  timezone: string | null
  availability: string | null
  builderRole: string | null
  website: string | null
  githubUsername: string | null
  twitterUsername: string | null
  linkedinUrl: string | null
  xp: number
  /** Live rank from the XP log (0 when the user has no XP). */
  rank: number
  reputationScore: number
  role: 'USER' | 'MODERATOR' | 'ADMIN'
  verificationLevel: 'NONE' | 'EMAIL' | 'PHONE' | 'GITHUB' | 'PORTFOLIO' | 'ORGANIZATION' | 'IDENTITY'
  isEmailVerified: boolean
  githubConnected: boolean
  portfolioVerified: boolean
  organizationVerified: boolean
  createdAt: IsoDate
  skills: UserSkillEntry[]
  /** Evidence AND peer endorsements (type PEER_ENDORSEMENT). Prefer GET /api/evidence for the evidence list. */
  skillEvidences: EvidenceRow[]
  ownedProjects: ProjectRef[]
  /** Projects the user is a member of (not owner). */
  projects: { role: string; project: ProjectRef }[]
  ownedTeams: TeamRef[]
  teams: { role: TeamRole; team: TeamRef }[]
  achievements: EarnedAchievement[]
  currentBuild: CurrentBuild | null
  /** null when viewing your own profile. */
  compatibility: number | null
  /** true when the viewer has blocked this user (offer "unblock"). */
  blockedByMe: boolean
}

export interface CurrentBuild {
  id: string
  userId: string
  title: string
  description: string | null
  status: ProjectStatus
  progress: number
  techStack: string[]
  teamSize: number
  maxTeamSize: number
  rolesNeeded: string[]
  hackathonId: string | null
  githubUrl: string | null
  demoUrl: string | null
  isPublic: boolean
  createdAt: IsoDate
  updatedAt: IsoDate
}

// ---------------------------------------------------------------------------
// Projects, teams, hackathons
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: string
  name: string
  slug: string
  description: string | null
  shortDesc: string | null
  status: ProjectStatus
  ownerId: string
  hackathonId: string | null
  githubUrl: string | null
  demoUrl: string | null
  websiteUrl: string | null
  thumbnail: string | null
  isPublic: boolean
  teamSize: number
  maxTeamSize: number
  lookingFor: string[]
  techStack: string[]
  startedAt: IsoDate | null
  shippedAt: IsoDate | null
  createdAt: IsoDate
  updatedAt: IsoDate
  owner: UserSummary
  members: { userId: string; role: string; user: UserSummary }[]
  hackathon: { id: string; name: string; slug: string } | null
  _count: { members: number; updates: number; milestones: number }
}

export interface ProjectsResponse {
  projects: ProjectListItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface TeamListItem {
  id: string
  name: string
  slug: string
  description: string | null
  projectId: string | null
  hackathonId: string | null
  ownerId: string
  maxSize: number
  isRecruiting: boolean
  lookingFor: string[]
  createdAt: IsoDate
  updatedAt: IsoDate
  owner: UserSummary
  members: { id: string; userId: string; teamId: string; role: TeamRole; joinedAt: IsoDate; user: UserWithRole }[]
  project: { id: string; name: string; slug: string; status: ProjectStatus } | null
  hackathon: { id: string; name: string; slug: string } | null
  _count: { members: number; applications: number }
}

export interface TeamsResponse {
  teams: TeamListItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface HackathonListItem {
  id: string
  name: string
  slug: string
  description: string
  shortDesc: string | null
  startDate: IsoDate
  endDate: IsoDate
  registrationDeadline: IsoDate | null
  status: HackathonStatus
  organizer: string | null
  websiteUrl: string | null
  prizePool: string | null
  rules: string | null
  technologies: string[]
  maxTeamSize: number
  minTeamSize: number
  location: string | null
  isPublic: boolean
  thumbnail: string | null
  banner: string | null
  createdAt: IsoDate
  updatedAt: IsoDate
  _count: { participants: number; teams: number }
  /** The signed-in user is registered. */
  registered: boolean
  /** The team the user entered with, if any (drives a "My team" action). */
  myTeamId: string | null
  myStatus: 'REGISTERED' | 'TEAM_FORMED' | 'SUBMITTED' | 'WITHDRAWN' | null
}

export interface HackathonsResponse {
  hackathons: HackathonListItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export interface MessagePreview {
  id: string
  conversationId: string
  senderId: string
  /** null when the message was deleted. */
  content: string | null
  type: string
  replyToId: string | null
  editedAt: IsoDate | null
  deletedAt: IsoDate | null
  isDeleted: boolean
  createdAt: IsoDate
  sender: { id: string; name: string | null; username: string | null }
}

/** POST /api/conversations/[id]: the message just sent plus the sender's rewards (5 XP for a first message to a connection). */
export type SendMessageResponse = WithRewards<{
  id: string
  conversationId: string
  senderId: string
  content: string
  type: string
  replyToId: string | null
  createdAt: IsoDate
  sender: UserSummary
}>

export interface ConversationListItem {
  id: string
  type: ConversationType
  /** Null for direct conversations: show the other member's name. */
  name: string | null
  projectId: string | null
  teamId: string | null
  hackathonId: string | null
  createdAt: IsoDate
  updatedAt: IsoDate
  members: { id: string; userId: string; role: string; lastReadAt: IsoDate | null; user: UserWithHeadline }[]
  /** At most one: the latest message, the "last message" preview. */
  messages: MessagePreview[]
  project: { id: string; name: string; slug: string } | null
  team: { id: string; name: string; slug: string } | null
  hackathon: { id: string; name: string; slug: string } | null
  _count: { messages: number }
  unreadCount: number
}

export interface ConversationsResponse {
  conversations: ConversationListItem[]
  totalUnread: number
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface ReactionSummary {
  emoji: string
  count: number
  reactedByMe: boolean
}

/** POST /api/messages/[id]/reactions (a toggle). */
export interface ReactionResponse {
  reacted: boolean
  reactions: ReactionSummary[]
}

/** GET /api/messages/[id]/reactions. */
export interface MessageReactionsResponse {
  messageId: string
  reactions: ReactionSummary[]
}

export interface MarkReadResponse {
  conversationId: string
  readCount: number
  unreadCount: number
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

/** One row of a leaderboard. */
export interface LeaderboardEntry {
  /** 1 is first. The person's place on the board, the same for every viewer and the same as on their player card. Blocked people are left out of the list, so ranks can skip. */
  rank: number
  /** XP earned in the board's period. */
  score: number
  /** The same number as `score`, kept for clients written before periods existed. */
  xp: number
  level: number
  tier: Tier
  user: UserWithHeadline & { builderRole: string | null }
}

/**
 * GET /api/leaderboard?period=&scope=&scopeId=&cursor=&limit=
 *
 *  - `period`: `weekly`, `monthly`, `season` or `all-time` (default). Weeks and months are UTC.
 *  - `scope`: `global` (default), `country`, `city`, `campus` or `crew`. For the first four `scopeId` defaults to
 *    the user's own place (`myScopes` has them); `crew` needs the team id.
 *  - the page: `cursor` (the previous `nextCursor`) or `page`, with `limit` (1 to 100, default 50).
 */
export interface LeaderboardResponse {
  period: 'weekly' | 'monthly' | 'season' | 'all-time'
  scope: { type: 'global' | 'country' | 'city' | 'campus' | 'crew'; id: string | null }
  /** Present for the season period: which season it is and when it ends. Null between seasons. */
  season: { id: string; number: number; name: string; startsAt: IsoDate; endsAt: IsoDate } | null
  entries: LeaderboardEntry[]
  /** The caller's own standing on this board; `rank` is null when they are not on it (no XP in the period, or opted out). */
  me: { rank: number | null; score: number; xp: number; hidden: boolean }
  /** The caller and the two above and two below them (fewer at the edges); empty when `me.rank` is null. */
  around: LeaderboardEntry[]
  /** The ids of the caller's own country, city and campus boards, for building a scope picker. Null where not set. */
  myScopes: { country: string | null; city: string | null; campus: string | null }
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface ActivityItem {
  id: string
  userId: string
  type: string
  title: string
  description: string | null
  link: string | null
  metadata: Record<string, unknown> | null
  createdAt: IsoDate
  project: { id: string; name: string; slug: string } | null
}

export interface ActivityResponse {
  activity: ActivityItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface EvidenceRow {
  id: string
  userId: string
  skillId: string
  type: string
  title: string
  description: string | null
  url: string | null
  verifiedAt: IsoDate | null
  createdAt: IsoDate
}

export interface EvidenceItem extends EvidenceRow {
  skill: { id: string; name: string; slug: string; category: string }
  endorsementCount: number
  endorsedByMe: boolean
}

export interface EvidenceResponse {
  evidence: EvidenceItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface EndorseResponse {
  endorsed: boolean
  endorsementCount: number
}

// ---------------------------------------------------------------------------
// Project progress
// ---------------------------------------------------------------------------

export interface ProjectUpdateItem {
  id: string
  projectId: string
  title: string
  content: string
  type: 'UPDATE' | 'ANNOUNCEMENT' | 'MILESTONE' | 'SHIPPED'
  createdAt: IsoDate
  author: UserSummary
}

export interface ProjectUpdatesResponse {
  updates: ProjectUpdateItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface MilestoneItem {
  id: string
  projectId: string
  title: string
  description: string | null
  dueDate: IsoDate | null
  completedAt: IsoDate | null
  completed: boolean
  order: number
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface MilestonesResponse {
  milestones: MilestoneItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Connections, blocks, notifications
// ---------------------------------------------------------------------------

export interface ConnectionItem {
  id: string
  senderId: string
  receiverId: string
  type: ConnectionType
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'BLOCKED'
  message: string | null
  createdAt: IsoDate
  updatedAt: IsoDate
  sender: UserWithHeadline
  receiver: UserWithHeadline
}

/** PATCH /api/connections/[id]: the updated connection plus the caller's own rewards (10 XP when they accepted). */
export type ReviewConnectionResponse = WithRewards<ConnectionItem>

export interface ConnectionsResponse {
  connections: ConnectionItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface BlockItem {
  id: string
  createdAt: IsoDate
  reason: string | null
  user: UserWithHeadline
}

/** POST /api/blocks: 201 when created, 200 if the block already existed. */
export interface BlockResponse {
  block: BlockItem
  severedConnections: number
  withdrawnApplications: number
}

export interface BlocksResponse {
  blocks: BlockItem[]
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

export interface NotificationItem {
  id: string
  userId: string
  type: string
  title: string
  message: string
  link: string | null
  metadata: Record<string, unknown> | null
  isRead: boolean
  createdAt: IsoDate
}

export interface NotificationsResponse {
  notifications: NotificationItem[]
  unreadCount: number
  /** Present for page-numbered requests; absent when the request carried a `cursor`. */
  pagination?: Pagination
  /** Send as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** GET /api/dashboard. Recommendations exclude anyone blocked with or by the viewer. */
export interface DashboardResponse {
  currentBuild: (CurrentBuild & { hackathon: { id: string; name: string; slug: string; startDate: IsoDate; endDate: IsoDate; status: HackathonStatus } | null }) | null
  userProjects: (ProjectRef & { owner: UserSummary; _count: { members: number; milestones: number } })[]
  userTeams: TeamListItem[]
  hackathonParticipations: { id: string; hackathonId: string; status: string; teamId: string | null; hackathon: HackathonListItem }[]
  userQuests: unknown[]
  recentActivities: ActivityItem[]
  xpEvents: { id: string; type: string; amount: number; description: string; createdAt: IsoDate }[]
  userSkills: UserSkillEntry[]
  recommendedBuilders: (UserListItem & { commonSkills: string[]; compatibility: number; _count: { projects: number; hackathons: number; achievements: number } })[]
  recruitingTeams: TeamListItem[]
  upcomingHackathons: HackathonListItem[]
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export type Tier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND' | 'MYTHIC'

/**
 * What one request earned the signed-in user. Every mutation that can award
 * anything returns it as `rewards` next to its normal body, also when nothing
 * was earned (`xpGained: 0`), so the interface can always read it. See
 * docs/GAMIFICATION.md for the rules.
 */
export interface RewardsEnvelope {
  /** XP added by this request, achievement XP included. */
  xpGained: number
  /** The user's XP after this request. */
  totalXp: number
  oldLevel: number
  newLevel: number
  leveledUp: boolean
  oldTier: Tier
  newTier: Tier
  tierChanged: boolean
  /** Achievements unlocked by this request. */
  achievements: { slug: string; name: string }[]
  /** Quests completed by this request. */
  questsCompleted: { slug: string; name: string }[]
  /** The user's streak after this request. */
  streak: StreakStatus
}

/**
 * A daily streak: consecutive local days (in the user's time zone) on which they earned XP from an
 * action of their own. `current` is what to show now: 0 once a day was missed with no freeze to cover it.
 */
export interface StreakStatus {
  current: number
  longest: number
  /** This request is the first of the local day to count, and the streak grew (or started) because of it. */
  extended: boolean
  /** A banked freeze covered a missed day to keep the streak alive. */
  freezeUsed: boolean
}

/**
 * GET /api/users/{id}/stats: the player card, everything a profile header shows about progress, in one
 * call. Cached for 60 seconds and refreshed by every award. `ranks` are the absolute places on the all-time
 * boards (not the place among the people you can see, which the leaderboard gives), null where the person is
 * not on the board (no XP, no country or city set, or opted out of leaderboards).
 */
export interface PlayerCard {
  userId: string
  xp: number
  level: number
  tier: Tier
  /** Progress through the current level. `fraction` is 0 to 1 and 1 at the top level. */
  progress: { xpIntoLevel: number; xpForNextLevel: number; fraction: number }
  ranks: { global: number | null; country: number | null; city: number | null }
  /** Null for somebody else's card when the person keeps their activity private. */
  streak: { current: number; longest: number; freezes: number; lastDay: string | null } | null
  /** What the person wears, named. */
  equipped: {
    title: { slug: string; name: string } | null
    frame: { slug: string; name: string } | null
    banner: { slug: string; name: string } | null
    /** At most three, in the order the person put them. */
    badges: { slug: string; name: string }[]
  }
  /** The three rarest achievements earned, rarest first. */
  topAchievements: { slug: string; name: string; icon: string | null; rarity: number | null; earnedAt: IsoDate }[]
  counts: {
    /** Projects shipped. */
    shipped: number
    /** Hackathons registered for. */
    hackathons: number
    /** Hackathons won. */
    wins: number
    endorsementsReceived: number
    /** Teams the person is in now. */
    crews: number
    /** Milestones completed. */
    milestones: number
  }
}

/** What a person wears: the slug of a cosmetic they own in each slot, or null. */
export interface EquippedCosmetics {
  title: string | null
  frame: string | null
  banner: string | null
  /** Up to three badge slugs, in display order. */
  badges: string[]
}

/**
 * One cosmetic in the catalog. Cosmetics are only ever earned. One that is earned by a secret achievement stays
 * `masked` (placeholder slug `secret-<order>`, no name, text or requirement) until the user owns it.
 */
export interface CosmeticItem {
  slug: string
  type: 'TITLE' | 'FRAME' | 'BANNER' | 'BADGE' | 'AVATAR_PART'
  name: string
  description: string
  rarity: 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY'
  /** Which of `EquippedCosmetics` it goes in; null for a type that cannot be worn yet. */
  slot: 'title' | 'frame' | 'banner' | 'badges' | null
  owned: boolean
  masked: boolean
  /** Being worn right now. */
  equipped: boolean
  unlockedAt: IsoDate | null
  /** What earns it, for one that is not owned yet (null once owned, and while masked). */
  requirement: string | null
  order: number
}

/** GET /api/users/me/cosmetics, and the body PATCH /api/users/me/equipped answers with is `{ equipped }`. */
export interface CosmeticsResponse {
  equipped: EquippedCosmetics
  cosmetics: CosmeticItem[]
  owned: number
  total: number
}

/** One quest as GET /api/quests lists it. */
export interface QuestItem {
  slug: string
  name: string
  description: string
  type: 'DAILY' | 'WEEKLY'
  /** XP completing it pays (once). */
  xpReward: number
  /** How many times the action must be done in the period. */
  target: number
  /** How many times it has been done so far this period, up to `target`. */
  current: number
  completed: boolean
  completedAt: IsoDate | null
}

/** One set of quests: this local day's, or this local week's. */
export interface QuestGroup {
  /** The local date ("2026-10-16") or ISO week ("2026-W42"). */
  periodKey: string
  startsAt: IsoDate
  /** When these quests reset and a new set begins: the first instant of the next local day or week. */
  resetsAt: IsoDate
  quests: QuestItem[]
}

/**
 * GET /api/quests: three daily and three weekly quests. They are the same for the whole period and
 * the same on every device (they follow from the user and the period), and every one is a useful
 * action: nothing rewards opening the app.
 */
export interface QuestsResponse {
  /** false while an operator has paused quests (the "quests" flag): both lists are then empty and nothing counts. */
  enabled: boolean
  /** The zone the day and week are measured in (UTC until the user sets one). */
  timezone: string
  daily: QuestGroup
  weekly: QuestGroup
}

/** One local day of the heatmap. */
export interface HeatmapDay {
  /** The local date in the profile owner's time zone, "YYYY-MM-DD". */
  date: string
  /** XP earned that day, achievement and quest XP included. */
  xp: number
  /** Things the person did that day that paid XP (not counting the achievements and quests they led to). */
  actions: number
}

/**
 * GET /api/users/{id}/heatmap?days=365 (1 to 365). Only days with activity are listed, oldest
 * first; draw the rest as empty. Days are the profile OWNER's local days (`timezone`).
 */
export interface HeatmapResponse {
  timezone: string
  days: number
  /** First and last local date covered, inclusive. */
  from: string
  to: string
  /** true: the owner has switched "show activity" off and `items` is empty. Never true for your own. */
  hidden: boolean
  items: HeatmapDay[]
}

/** A mutation response that also reports what it earned. */
export type WithRewards<T> = T & { rewards: RewardsEnvelope }

// ---------------------------------------------------------------------------
// Profile settings
// ---------------------------------------------------------------------------

/** GET and PATCH /api/users/me/profile: where the signed-in user is, and what others can see. */
export interface ProfileSettings {
  /** IANA name such as "Asia/Kolkata". Days, streaks, quests and daily caps follow it; UTC when null. */
  timezone: string | null
  /** ISO 3166-1 alpha-2, upper case. Puts the user on the country board. */
  countryCode: string | null
  /** Tidied free text. Puts the user on that city's board (within their country). */
  city: string | null
  /** Tidied free text. Puts the user on that campus's board. */
  campus: string | null
  /** Removes the user from every leaderboard and from every rank other people can see. */
  hideFromLeaderboards: boolean
  /** false: other people get an empty heatmap for this user. */
  showActivity: boolean
  /**
   * "YYYY-MM-DD", PRIVATE: only this endpoint, for the owner, ever returns it. Needed to use dating (18 or older). Set once and then
   * locked: sending a different date afterwards is `409 BIRTH_DATE_LOCKED`. It cannot be cleared.
   */
  birthDate: string | null
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** GET /api/health: public, for uptime monitors. 503 only when `status` is "down". */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down'
  time: IsoDate
  checks: Record<'database' | 'cache' | 'jobs' | 'realtime', { status: 'ok' | 'down'; provider: string; latencyMs?: number }>
}

/** GET /api/flags: every flag with its answer for the signed-in user. */
export interface FlagsResponse {
  flags: Record<string, boolean>
}

/** A feature flag as the admin API returns it. */
export interface AdminFlag {
  key: string
  description: string | null
  enabled: boolean
  /** 0 to 100: the share of users the flag is on for while it is enabled. */
  rolloutPercent: number
  /** On for these users whatever the switch and the percentage say. */
  allowUserIds: string[]
  updatedById: string | null
  createdAt: IsoDate
  updatedAt: IsoDate
}

/** GET /api/admin/flags (admin only). */
export interface AdminFlagsResponse {
  flags: AdminFlag[]
  nextCursor: string | null
}
