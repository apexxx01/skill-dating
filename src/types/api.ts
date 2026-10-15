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

export interface LeaderboardResponse {
  entries: {
    rank: number
    xp: number
    user: UserWithHeadline & { builderRole: string | null }
  }[]
  me: { xp: number; rank: number | null }
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
  /** Quests completed by this request. Always empty until quests ship. */
  questsCompleted: { slug: string; name: string }[]
  /** Streak state after this request. Always null until streaks ship. */
  streak: null
}

/** A mutation response that also reports what it earned. */
export type WithRewards<T> = T & { rewards: RewardsEnvelope }

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
