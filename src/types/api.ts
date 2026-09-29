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

/** Every non-2xx response has this shape. */
export interface ApiError {
  error: string
  details?: unknown
}

/** Rate limited (429) and temporarily unavailable (503) responses. */
export interface RateLimitedError {
  error: string
  retryAfter?: number
}

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
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
  pagination: Pagination
}

export type UserListItem = Omit<DiscoverPerson, 'compatibility'>

export interface UsersResponse {
  users: UserListItem[]
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
  pagination: Pagination
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
