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
  /** The passport's "Reliable teammate" badge (docs/SQUADS.md). The reliability number behind it is never sent. */
  reliableTeammate: boolean
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
  /** When the teams lock; the end date when null. */
  submissionDeadline: IsoDate | null
  status: HackathonStatus
  /** NATIVE: run here. EXTERNAL: lives on another platform (`externalUrl`, `platform`), this is its team layer. */
  source: 'NATIVE' | 'EXTERNAL'
  externalUrl: string | null
  platform: 'DEVFOLIO' | 'DEVPOST' | 'MLH' | 'UNSTOP' | 'LUMA' | 'OTHER' | null
  mode: 'ONLINE' | 'IN_PERSON' | 'HYBRID' | null
  city: string | null
  country: string | null
  tracks: { name: string; description: string | null }[]
  /** An external hackathon no admin has verified yet: usable for squads, pays no XP. Show it flagged. */
  unverified: boolean
  verifiedAt: IsoDate | null
  resultsAt: IsoDate | null
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

/** One channel of one kind in GET and PUT /api/notifications/channels. */
export interface ChannelSwitch {
  /** What is on now: the person's own choice, else the default. */
  enabled: boolean
  default: boolean
  /** False where the kind is never sent on this channel (a digest by push): show no switch. */
  available: boolean
}

export interface NotificationChannelKind {
  /** A delivery kind (docs/NOTIFICATIONS.md): a notification kind, or DIGEST_DAILY / DIGEST_WEEKLY. */
  kind: string
  label: string
  class: 'ACTIVITY' | 'PROMOTIONAL'
  email: ChannelSwitch
  push: ChannelSwitch
}

/** GET and PUT /api/notifications/channels */
export interface NotificationChannelsResponse {
  settings: {
    emailEnabled: boolean
    pushEnabled: boolean
    quietHours: { enabled: boolean; /** "22:00": local time. */ start: string; end: string }
    dailyDigest: boolean
    weeklyDigest: boolean
  }
  kinds: NotificationChannelKind[]
  /** Digests are promotional mail: they need this consent (POST /api/users/me/consents). */
  marketingConsent: boolean
  push: { devices: number; configured: boolean }
  /** `undeliverable`: mail to the address bounced or was reported as spam, so no email is sent until it changes. */
  email: { verified: boolean; undeliverable: boolean }
}

export interface PushDevice {
  id: string
  label: string | null
  createdAt: IsoDate
  lastUsedAt: IsoDate | null
}

/** GET /api/notifications/push */
export interface PushDevicesResponse {
  /** The VAPID public key: pass it to PushManager.subscribe() as applicationServerKey. */
  publicKey: string
  /** False in development and preview, where pushes are recorded and not sent. */
  configured: boolean
  devices: PushDevice[]
  maxDevices: number
}

/** The body of POST /api/notifications/push: subscription.toJSON(), plus an optional label. */
export interface PushSubscribeBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
  label?: string
}

/** What a web push carries (service worker `push` event: event.data.json()). */
export interface PushPayload {
  title: string
  body: string
  /** A path in the app: open it on a tap. */
  url: string
  tag?: string
  /** Report a tap with POST /api/notifications/deliveries/{deliveryId}/open. */
  deliveryId?: string
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchTypeName = 'users' | 'projects' | 'crews' | 'hackathons' | 'posts'

export type SearchHit =
  | { type: 'user'; id: string; username: string; name: string | null; /** Only when the person made it public. */ headline: string | null; image: string | null }
  | { type: 'project'; id: string; slug: string; name: string; summary: string | null; status: string; isPublic: boolean }
  | { type: 'crew'; id: string; slug: string; name: string; summary: string | null; isRecruiting: boolean; memberCount: number }
  | { type: 'hackathon'; id: string; slug: string; name: string; summary: string | null; status: string; startsAt: IsoDate; /** False for an external hackathon nobody has verified. */ verified: boolean }
  | { type: 'post'; id: string; title: string; excerpt: string; kind: string; createdAt: IsoDate; author: { id: string; username: string; name: string | null } }

/** GET /api/search?q=&types=&limit=&cursor= */
export interface SearchResponse {
  /** The query as it was searched: lower case, no accents or punctuation. */
  query: string
  types: SearchTypeName[]
  /** One list in rank order, best first. */
  results: SearchHit[]
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
  /** The "Reliable teammate" badge, by the same rule as on the profile (docs/SQUADS.md). The reliability number behind it is never sent. */
  reliableTeammate: boolean
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

// ---------------------------------------------------------------------------
// Matching: drops, sparks and matches (docs/MATCHING.md)
// ---------------------------------------------------------------------------

export type MatchTypeName = 'COFOUNDER' | 'HACKATHON_TEAMMATE' | 'COLLABORATOR' | 'MENTOR' | 'MENTEE' | 'DATING'

/** The short card of a person in the matching screens. Public profile fields only. */
export interface MatchPerson {
  id: string
  name: string | null
  username: string
  image: string | null
  headline: string | null
  builderRole: string | null
  location: string | null
  level: number
  tier: Tier
  /** Their five strongest skills. */
  skills: { slug: string; name: string; level: number }[]
  proof: { verifiedEvidence: number; shipped: number }
}

/** One person shown to the caller for one local day. */
export interface DropItem {
  id: string
  /** The relationship, from the caller's side: a MENTEE is shown mentors. */
  connectionType: MatchTypeName
  /** 0 to 100. */
  score: number
  /** At most three lines saying why. */
  reasons: string[]
  status: 'NEW' | 'SPARKED' | 'PASSED' | 'EXPIRED'
  /** Resurfaced because the person has grown since the caller passed. */
  secondLook: boolean
  expiresAt: IsoDate
  candidate: MatchPerson
}

/** GET /api/drops/today. */
export interface TodayDrops {
  /** The caller's own calendar day, "YYYY-MM-DD". */
  date: string
  drops: DropItem[]
  /** False until the caller has saved a matching profile: show the setup instead. */
  hasProfile: boolean
  paused: boolean
  dropTimeLocal: string
  /** When the next drops arrive, to the hour (they are made by an hourly job). Null while paused or without a profile. */
  nextDropAt: IsoDate | null
}

/** A spark the caller sent. */
export interface SparkSent {
  id: string
  toId: string
  /** The caller's side of the relationship. */
  connectionType: MatchTypeName
  opener: string
  status: 'PENDING' | 'MATCHED'
  createdAt: IsoDate
}

/** One match, from the caller's side. */
export interface MatchItem {
  id: string
  /** The relationship, named the same from both sides (a mentor and a mentee are a `MENTOR` match). */
  connectionType: MatchTypeName
  yourRole: MatchTypeName
  theirRole: MatchTypeName
  createdAt: IsoDate
  /** The conversation both are in. Its `closedAt` says whether it can still be posted in. */
  conversationId: string | null
  other: MatchPerson
}

/** POST /api/sparks: the spark, and the match when the other person had already sparked back (otherwise null). */
export interface SendSparkResponse {
  spark: SparkSent
  match: MatchItem | null
}

/** GET /api/matches. Only open matches. */
export interface MatchesResponse {
  matches: MatchItem[]
  nextCursor: string | null
  total: number
}

/** One spark the caller received and has not answered. */
export interface ReceivedSparkItem {
  id: string
  /** The sender's side of the relationship: answer with a spark of the counterpart type (a MENTOR spark is answered as MENTEE). */
  connectionType: MatchTypeName
  opener: string
  createdAt: IsoDate
  from: MatchPerson
}

/**
 * GET /api/sparks/received. Who sparked and what they wrote is a paid feature (`SEE_WHO_SPARKED`): without it `canSee` is false, `sparks`
 * is empty and only `count` is returned.
 */
export interface ReceivedSparks {
  canSee: boolean
  count: number
  sparks: ReceivedSparkItem[]
  nextCursor: string | null
}

/** A skill or role a team asked for or builds with, and where the need came from. */
export interface TeamGapNeed {
  name: string
  /** Set for a skill of the catalog; roles ("Designer") have no slug. */
  slug?: string
  sources: ('TEAM_NEEDS' | 'PROJECT_NEEDS' | 'PROJECT_STACK')[]
}

/** One person who could fill what a team is missing. */
export interface TeamGapCandidate {
  person: MatchPerson
  /** The kind of teammate they would be: HACKATHON_TEAMMATE for a hackathon team, COLLABORATOR or COFOUNDER otherwise. Never DATING. */
  connectionType: MatchTypeName
  /** 0 to 100, from the same scorer as the daily drops. */
  score: number
  /** At most three lines saying why. */
  reasons: string[]
  /** Names of the team's missing skills this person has. */
  fills: string[]
}

/** GET /api/teams/{id}/gaps (the team's owner or admin). */
export interface TeamGapsResponse {
  team: { id: string; name: string; maxSize: number; memberCount: number; openSlots: number }
  /** What was asked for, as written: the team's `lookingFor`, its project's `lookingFor`, and its project's tech stack. */
  needs: { team: string[]; project: string[]; stack: string[] }
  missing: { skills: TeamGapNeed[]; roles: TeamGapNeed[] }
  covered: { skills: (TeamGapNeed & { memberIds: string[] })[]; roles: (TeamGapNeed & { memberIds: string[] })[] }
  /** Technologies of the project that are not skills of the catalog, so cannot be checked against anyone. */
  unmatchedStack: string[]
  /** The five best fits, best first. Invite one with POST /api/teams/{id}/invitations. */
  candidates: TeamGapCandidate[]
}

// --- Posts, Props, the feed and Ship Day (docs/FEED.md) -------------------------------------------------

export type PostKindName = 'SHIP' | 'UPDATE' | 'DEVLOG' | 'DEMO'
export type PostVisibilityName = 'PUBLIC' | 'FOLLOWERS' | 'CREW'

export interface PostPerson {
  id: string
  name: string | null
  username: string
  image: string | null
  level: number
  tier: string
}

/** One post as the caller may see it. `body` is sanitized Markdown source: render it, never inject it as HTML. */
export interface PostItem {
  id: string
  kind: PostKindName
  title: string
  body: string
  links: string[]
  media: { id: string; type: 'IMAGE' | 'GIF' | 'VIDEO'; url: string; width: number; height: number; durationMs: number | null }[]
  /** Includes `ship-day` for a post made on the author's Friday. */
  stackTags: string[]
  visibility: PostVisibilityName
  shipDay: boolean
  author: PostPerson
  coAuthors: PostPerson[]
  project: { id: string; name: string; slug: string } | null
  teamId: string | null
  /** The sum of the weighted Props. Show `propsCount` as the number of people; use this only to order or to size a badge. */
  propsScore: number
  propsCount: number
  commentCount: number
  /** Whether the caller has given Props. */
  yourProps: boolean
  /** Edits so far; 0 for a post never edited. */
  revision: number
  createdAt: string
  editedAt: string | null
}

/** POST /api/posts */
export interface CreatePostResponse {
  post: PostItem | null
  /** True when this post shipped its project (the first SHIP post of a project). */
  shipped: boolean
}

/** GET /api/feed */
export interface FeedResponse {
  tab: 'for-you' | 'following' | 'city' | 'campus'
  posts: PostItem[]
  nextCursor: string | null
}

/** GET /api/projects/{id}/timeline, GET /api/users/{id}/posts, GET /api/posts */
export interface PostsPageResponse {
  posts: PostItem[]
  nextCursor: string | null
}

export interface PostCommentItem {
  id: string
  postId: string
  parentId: string | null
  author: { id: string; name: string | null; username: string; level: number; tier: string } | null
  /** Null once deleted: show "deleted" and keep the replies under it. */
  body: string | null
  deleted: boolean
  createdAt: string
  editedAt: string | null
  replies?: PostCommentItem[]
  replyCount?: number
}

/** GET /api/posts/{id}/comments */
export interface PostCommentsResponse {
  comments: PostCommentItem[]
  nextCursor: string | null
}

/** POST/DELETE /api/posts/{id}/props */
export interface PropsResponse {
  propsScore: number
  propsCount: number
  yourProps: boolean
  /** Only on a POST: false when the caller had already given Props. */
  created?: boolean
}

/** GET /api/users/{id}/followers, GET /api/users/{id}/following */
export interface FollowPeopleResponse {
  people: { id: string; username: string; name: string | null; image: string | null; level: number; tier: string; followedAt: string }[]
  nextCursor: string | null
}

/** GET /api/ship-day */
export interface ShipDayResponse {
  /** Whether the caller's Friday is today (their own time zone). */
  isShipDay: boolean
  startsAt: string
  endsAt: string
  /** The caller's Friday of this week, "YYYY-MM-DD". */
  dateKey: string
  weekKey: string
  todayCount: number
  yourShips: PostItem[]
  topPosts: PostItem[]
  lastRecap: { weekKey: string; dateKey: string; totalPosts: number } | null
}

// --- Squads: hackathon team building (docs/SQUADS.md) --------------------------------------------------------

/** The fixed role catalogue of a slot, a member's squad role and the builder's templates. */
export type SquadRole = 'FRONTEND' | 'BACKEND' | 'FULLSTACK' | 'MOBILE' | 'ML_AI' | 'DATA' | 'DEVOPS' | 'DESIGN_UI_UX' | 'PRODUCT' | 'PITCH_BUSINESS' | 'HARDWARE' | 'OTHER'

/** A role slot on a team (GET /api/teams/{id}/slots, and `slots` on a team). `customLabel` only for OTHER. */
export interface TeamSlotItem {
  id: string
  teamId: string
  role: SquadRole
  customLabel: string | null
  requiredSkills: string[]
  status: 'OPEN' | 'FILLED'
  filledById: string | null
  filledAt: string | null
  position: number
  filledBy?: { id: string; name: string | null; username: string | null; image: string | null } | null
}

/** GET /api/teams/{id}/slots */
export interface TeamSlotsResponse {
  slots: TeamSlotItem[]
  capacity: number
  memberCount: number
  openPlaces: number
  locked: boolean
}

export type StrengthComponentKey = 'roleCoverage' | 'skillCoverage' | 'timezoneOverlap' | 'commitmentFit' | 'experienceMix' | 'chemistry'
export type StrengthGapCode = 'TOO_SMALL' | 'MISSING_ROLE' | 'NO_DEPLOYER' | 'MISSING_SKILLS' | 'LOW_TIMEZONE_OVERLAP' | 'UNCONFIRMED_PLEDGES' | 'HOURS_MISMATCH'

export interface SquadStrengthSummary {
  /** 0 to 100. */
  score: number
  components: Record<StrengthComponentKey, { value: number; weight: number; points: number; applicable: boolean; known: boolean }>
  /** Most important first; show `message`, branch on `code`. */
  gaps: { code: StrengthGapCode; message: string }[]
  /** Hours of the working day the whole squad shares; null with fewer than two known time zones. */
  overlapHours: number | null
}

/** GET /api/teams/{id}/strength (members and admins only) */
export interface TeamStrengthResponse extends SquadStrengthSummary {
  teamId: string
  hackathonId: string | null
  roles: { key: string; label: string; userId: string | null }[]
  memberCount: number
  capacity: number
  pledgesExpected: boolean
}

/** A proposed squad: from the builder (BUILDER) or the solo pool (AUTO). */
export interface SquadProposal {
  id: string
  hackathonId: string
  kind: 'BUILDER' | 'AUTO'
  status: 'OPEN' | 'INVITED' | 'PROPOSED' | 'FORMED' | 'FAILED' | 'EXPIRED'
  size: number
  seed: number
  expiresAt: string
  teamId: string | null
  strength: SquadStrengthSummary
  members: { person: MatchPerson; role: SquadRole; roleLabel: string; reasons: string[]; onTeam: boolean }[]
}

/** POST /api/hackathons/{id}/squad-builder (201), GET .../squad-builder/{proposalId}, GET /api/squad-proposals/{id} */
export interface SquadProposalResponse {
  proposal: SquadProposal
}

/** POST /api/hackathons/{id}/squad-builder/{proposalId}/invite (201 when the team was created, else 200) */
export interface SquadInviteResponse {
  teamId: string
  created: boolean
  invitations: { userId: string; invitationId: string; slotId: string }[]
  skipped: { userId: string; reason: 'IN_ANOTHER_SQUAD' | 'BLOCKED' | 'ALREADY_INVITED' | 'NO_ROOM' }[]
}

/** PATCH /api/hackathons/{id}/participation */
export interface ParticipationResponse {
  hackathonId: string
  teamId: string | null
  status: 'REGISTERED' | 'TEAM_FORMED' | 'SUBMITTED' | 'WITHDRAWN'
  lookingForTeam: boolean
  preferredRoles: SquadRole[]
  openToAutoTeam: boolean
}

/** GET /api/squad-proposals */
export interface SquadProposalsResponse {
  proposals: {
    id: string
    hackathonId: string
    hackathonName: string
    kind: 'BUILDER' | 'AUTO'
    status: SquadProposal['status']
    expiresAt: string
    teamId: string | null
    size: number
    strength: number
    myRole: SquadRole
    myResponse: 'PENDING' | 'ACCEPTED' | 'DECLINED'
    createdAt: string
  }[]
  nextCursor: string | null
}

/** POST /api/squad-proposals/{id}/respond */
export interface SquadProposalRespondResponse {
  status: SquadProposal['status']
  teamId: string | null
  proposal: SquadProposal | null
}

/** One post on the looking-for-group board. */
export interface LfgPostItem {
  id: string
  hackathonId: string
  kind: 'PERSON' | 'TEAM'
  author: MatchPerson
  team: { id: string; name: string; slug: string; openSlots: number } | null
  roles: SquadRole[]
  stack: string[]
  timezone: string | null
  note: string
  expiresAt: string
  createdAt: string
  /** The author's fit to the viewer; null on the viewer's own post. */
  fit: { score: number; reasons: string[] } | null
  mine: boolean
}

/** GET /api/hackathons/{id}/lfg */
export interface LfgBoardResponse {
  posts: LfgPostItem[]
  nextCursor: string | null
}

/** GET /api/teams/{id}/space (members and admins only) */
export interface TeamSpaceResponse {
  team: { id: string; name: string; slug: string; ownerId: string; projectId: string | null; targetTracks: string[]; keptBuildingAt: string | null }
  hackathon: {
    id: string
    name: string
    slug: string
    startDate: string
    endDate: string
    submissionDeadline: string | null
    locksAt: string
    secondsLeft: number
    locked: boolean
    tracks: { name: string; description: string | null }[]
    unverified: boolean
  } | null
  roles: {
    userId: string
    name: string | null
    username: string | null
    image: string | null
    teamRole: 'OWNER' | 'ADMIN' | 'MEMBER'
    squadRole: SquadRole | null
    roleLabel: string | null
    pledge: { attendance: 'IN_PERSON' | 'REMOTE'; hoursAvailable: number; availableFrom: string; availableUntil: string } | null
  }[]
  openSlots: { id: string; role: SquadRole; label: string; requiredSkills: string[] }[]
  checklist: { id: string; title: string; done: boolean; doneAt: string | null; position: number; assignee: { id: string; name: string | null; username: string | null; image: string | null } | null }[]
  ideas: { id: string; title: string; description: string | null; voteCount: number; votedByMe: boolean; chosen: boolean; author: { id: string; name: string | null; username: string | null; image: string | null } }[]
  unconfirmedPledges: string[]
}

/** POST /api/teams/{id}/keep-building */
export interface KeepBuildingResponse {
  ok: true
  teamId: string
  projectId: string
  projectCreated: boolean
  rewards: RewardsEnvelope
}

/** PUT /api/teams/{id}/pledge */
export interface PledgeResponse {
  hackathonId: string
  teamId: string
  attendance: 'IN_PERSON' | 'REMOTE'
  hoursAvailable: number
  availableFrom: string
  availableUntil: string
  confirmedAt: string
}

/** GET /api/hackathons/{id}/peer-reviews: the caller's side only. */
export interface PeerReviewTodoResponse {
  window: { opensAt: string; closesAt: string; open: boolean }
  teammates: { userId: string; name: string | null; username: string | null; image: string | null; reviewed: boolean; mine: { showedUp: 'YES' | 'PARTLY' | 'NO'; wouldBuildAgain: boolean } | null }[]
}

/** POST /api/hackathons/external (201 created, 200 already known). `hackathon` is the stored hackathon with `unverified`. */
export interface ExternalHackathonResponse {
  hackathon: {
    id: string
    name: string
    slug: string
    source: 'NATIVE' | 'EXTERNAL'
    externalUrl: string | null
    platform: 'DEVFOLIO' | 'DEVPOST' | 'MLH' | 'UNSTOP' | 'LUMA' | 'OTHER' | null
    mode: 'ONLINE' | 'IN_PERSON' | 'HYBRID' | null
    city: string | null
    country: string | null
    startDate: string
    endDate: string
    status: 'UPCOMING' | 'ACTIVE' | 'ENDED' | 'CANCELLED'
    tracks: { name: string; description: string | null }[]
    verifiedAt: string | null
    unverified: boolean
  }
  created: boolean
}

/** GET /api/admin/hackathons/{id}/metrics */
export interface HackathonSquadMetricsResponse {
  hackathonId: string
  registered: number
  inTeam: number
  percentInTeam: number
  medianMinutesToTeam: number | null
  squads: number
  autoSquadsFormed: number
  builderProposalsInvited: number
  soloPool: number
}

// --- Trust, safety and privacy (Stage 1F; docs/SAFETY.md, docs/PRIVACY.md) ------------------------------------------

export type ReportTargetType = 'USER' | 'MESSAGE' | 'SHIP_POST' | 'COMMENT' | 'SPARK' | 'ROMANCE_PROFILE' | 'LFG_POST' | 'IDEA' | 'EXTERNAL_HACKATHON'
export type ReportReasonName =
  | 'HARASSMENT'
  | 'SPAM'
  | 'IMPERSONATION'
  | 'INAPPROPRIATE_CONTENT'
  | 'MINOR_SAFETY'
  | 'SCAM'
  | 'FAKE_PROFILE'
  | 'COPYRIGHT'
  | 'OTHER'
  | 'BIRTHDATE_CORRECTION'

/** POST /api/reports */
export interface CreateReportRequest {
  targetType?: ReportTargetType
  targetId?: string
  /** A report about a person, as before Stage 1F. */
  reportedId?: string
  reason: ReportReasonName
  description?: string
}

export type ModerationActionName = 'WARN' | 'HIDE_CONTENT' | 'REMOVE_CONTENT' | 'RESTRICT_FEATURE' | 'SUSPEND' | 'BAN' | 'APPROVE_MEDIA'
export type RestrictedFeatureName = 'romance' | 'messaging' | 'posting'

export interface AccountModerationState {
  suspendedUntil: IsoDate | null
  banned: boolean
  /** Restricted features with their end (null: until lifted). */
  restricted: Partial<Record<RestrictedFeatureName, IsoDate | null>>
}

/** GET /api/users/me/moderation */
export interface ModerationHistoryResponse {
  state: AccountModerationState
  actions: {
    id: string
    action: ModerationActionName
    targetType: string
    targetId: string
    category: string | null
    noteToUser: string | null
    feature: RestrictedFeatureName | null
    expiresAt: IsoDate | null
    appealableUntil: IsoDate | null
    canAppeal: boolean
    reversedAt: IsoDate | null
    createdAt: IsoDate
    appeal: { id: string; status: AppealStatusName } | null
  }[]
}

export type AppealStatusName = 'PENDING' | 'UPHELD' | 'OVERTURNED'

/** GET /api/appeals */
export interface AppealsResponse {
  appeals: { id: string; actionId: string; body: string; status: AppealStatusName; decisionNote: string | null; decidedAt: IsoDate | null; createdAt: IsoDate }[]
}

/** GET /api/mutes */
export interface MutesResponse {
  mutes: { user: { id: string; username: string; name: string | null; image: string | null }; createdAt: IsoDate }[]
}

export type FieldVisibility = 'PUBLIC' | 'CONNECTIONS' | 'PRIVATE'
export type PassportFieldName = 'bio' | 'headline' | 'location' | 'website' | 'githubUsername' | 'twitterUsername' | 'linkedinUrl' | 'availability' | 'builderRole' | 'timezone'

/** GET and PATCH /api/users/me/privacy */
export interface PrivacySettings {
  fieldVisibility: Record<PassportFieldName, FieldVisibility>
  hideFromLeaderboards: boolean
  hideFromRecruiters: boolean
  matchingPaused: boolean
  invisibleMode: boolean
  whoCanMessage: 'EVERYONE' | 'CONNECTIONS' | 'NOBODY'
  showActivity: boolean
}

/** GET and POST /api/users/me/export */
export interface DataExportResponse {
  export: {
    id: string
    status: 'PENDING' | 'READY' | 'FAILED'
    bytes: number | null
    createdAt: IsoDate
    completedAt: IsoDate | null
    expiresAt: IsoDate | null
    /** A signed link, set once READY, valid until expiresAt. */
    downloadUrl: string | null
  }
}

export type ConsentTypeName = 'TERMS' | 'PRIVACY' | 'ROMANCE_MODE' | 'MARKETING'

export interface ConsentState {
  type: ConsentTypeName
  currentVersion: string
  grantedVersion: string | null
  grantedAt: IsoDate | null
  current: boolean
  /** Accepted once, for an older version: must be accepted again. */
  stale: boolean
}

/** GET /api/users/me/consents */
export interface ConsentsResponse {
  consents: ConsentState[]
  required: ConsentTypeName[]
}

export type MediaStatusName = 'PENDING' | 'READY' | 'REJECTED' | 'SCANNING' | 'IN_REVIEW' | 'BLOCKED'

// Staff ------------------------------------------------------------------------------------------------------------------

export type RiskLevelName = 'LOW' | 'ELEVATED' | 'HIGH'

/** GET /api/admin/queue */
export interface QueueResponse {
  kind: 'reports' | 'appeals'
  items: ({ kind: 'REPORT'; id: string; reason: ReportReasonName; targetType: ReportTargetType | 'MEDIA'; targetId: string | null; reportedId: string; reporterId: string | null; source: 'USER' | 'AUTOMATED'; priority: number; status: string; createdAt: IsoDate } | { kind: 'APPEAL'; id: string; actionId: string; userId: string; body: string; createdAt: IsoDate })[]
  nextOffset: number | null
}

/** GET /api/admin/users/{id}/risk */
export interface RiskView {
  userId: string
  score: number
  level: RiskLevelName
  overrideLevel: RiskLevelName | null
  effectiveLevel: RiskLevelName
  factors: Partial<Record<'collusion' | 'reports' | 'blocks' | 'throttles' | 'velocity' | 'unverified', number>>
  computedAt: IsoDate | null
}
