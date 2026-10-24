// What the routes' source cannot say, written by hand for the OpenAPI document (docs/openapi.json): which tag an operation belongs to and the type its answer has (the one-line summaries are in
// summaries.ts). The rest of every operation (path, method, who may call it, limits, request schemas) is read from the routes by scripts/openapi/scan-routes.ts. A unit test checks that every key
// here names an operation that exists and that every type named exists in src/types/api.ts.

export const API_TAGS = [
  { name: 'Account', description: 'The signed-in person: session, profile, privacy, consents, data export, moderation notices.' },
  { name: 'Passport', description: 'People, their skills, evidence and endorsements, progress and activity.' },
  { name: 'Matching', description: 'Discover, the daily drops, sparks, matches and the matching profile.' },
  { name: 'Ship Feed', description: 'Posts, Props, comments, the feed and Ship Day.' },
  { name: 'Projects', description: 'Projects, their updates and milestones, and what people are building now.' },
  { name: 'Squads', description: 'Hackathons, squads (teams), role slots, the squad builder, the solo pool, the looking-for-group board and team spaces.' },
  { name: 'Progress', description: 'Leaderboards, achievements, quests, the dashboard.' },
  { name: 'Search', description: 'Universal search for the command palette.' },
  { name: 'Messaging', description: 'Connections, conversations and messages, blocks and mutes.' },
  { name: 'Notifications', description: 'In-app notifications, delivery channels, web push devices, unsubscribe.' },
  { name: 'Growth', description: 'Invite codes and campus chapters.' },
  { name: 'Safety', description: 'Reports and appeals.' },
  { name: 'Media', description: 'Uploads.' },
  { name: 'Share cards', description: 'Public images and their versioned addresses.' },
  { name: 'Halves (post-launch)', description: 'The private romance mode. It ships CLOSED: every route here except /api/romance/interest answers 503 ROMANCE_PAUSED until it is opened. Build against it last.' },
  { name: 'Admin', description: 'Staff only: moderation, metrics, flags, invites, campuses, jobs.' },
  { name: 'Platform', description: 'Health, feature flags, realtime, webhooks and the job runner.' },
] as const

export type TagName = (typeof API_TAGS)[number]['name']

const TAG_RULES: [RegExp, TagName][] = [
  [/^\/api\/romance(\/|$)/, 'Halves (post-launch)'],
  [/^\/api\/admin(\/|$)/, 'Admin'],
  [/^\/api\/(auth|users\/me)(\/|$)/, 'Account'],
  [/^\/api\/(webhooks|inngest|health|flags|realtime|openapi\.json)(\/|$)/, 'Platform'],
  [/^\/api\/(users|skills|evidence|activity|builds)(\/|$)/, 'Passport'],
  [/^\/api\/(discover|drops|sparks|matches|matching)(\/|$)/, 'Matching'],
  [/^\/api\/(feed|posts|comments|ship-day)(\/|$)/, 'Ship Feed'],
  [/^\/api\/projects(\/|$)/, 'Projects'],
  [/^\/api\/(teams|hackathons|squad-proposals)(\/|$)/, 'Squads'],
  [/^\/api\/(leaderboard|achievements|quests|dashboard)(\/|$)/, 'Progress'],
  [/^\/api\/search(\/|$)/, 'Search'],
  [/^\/api\/(connections|conversations|messages|blocks|mutes)(\/|$)/, 'Messaging'],
  [/^\/api\/notifications(\/|$)/, 'Notifications'],
  [/^\/api\/(invites|campus|campuses)(\/|$)/, 'Growth'],
  [/^\/api\/(reports|appeals)(\/|$)/, 'Safety'],
  [/^\/api\/media(\/|$)/, 'Media'],
  [/^\/api\/og(\/|$)/, 'Share cards'],
]

export function tagOf(path: string): TagName {
  const rule = TAG_RULES.find(([pattern]) => pattern.test(path))
  if (!rule) throw new Error(`no tag for ${path}: add a rule to src/lib/openapi/metadata.ts`)
  return rule[1]
}

/** The romance routes that are part of the launch: asking to be told. Everything else under /api/romance is post-launch. */
export const isPostLaunch = (path: string): boolean => path.startsWith('/api/romance') && path !== '/api/romance/interest'

/** Operations that answer with a file or an image rather than JSON. */
export const NON_JSON: Record<string, string> = {
  'GET /api/admin/metrics/export.csv': 'text/csv',
  'GET /api/admin/hackathons/{id}/teams.csv': 'text/csv',
  'GET /api/og/achievement/{slug}': 'image/png',
  'GET /api/og/passport/{username}': 'image/png',
  'GET /api/og/post/{id}': 'image/png',
  'GET /api/og/squad/{id}': 'image/png',
  'GET /api/media/dev-download/{key}': 'application/octet-stream',
}

export interface ResponseSpec {
  /** A name exported from src/types/api.ts. */
  type: string
  status?: number
}

/** The type of the answer, by operation. An operation absent here answers with an untyped object (the unit test counts them and fails when the list grows). */
export const RESPONSES: Record<string, ResponseSpec> = {
  'GET /api/achievements': { type: 'AchievementsResponse' },
  'GET /api/activity': { type: 'ActivityResponse' },
  'GET /api/admin/flags': { type: 'AdminFlagsResponse' },
  'POST /api/admin/flags': { type: 'AdminFlag', status: 201 },
  'GET /api/admin/flags/{key}': { type: 'AdminFlag' },
  'PATCH /api/admin/flags/{key}': { type: 'AdminFlag' },
  'GET /api/admin/metrics': { type: 'MetricsResponse' },
  'GET /api/admin/queue': { type: 'QueueResponse' },
  'GET /api/admin/users/{id}/risk': { type: 'RiskView' },
  'PATCH /api/admin/users/{id}/risk': { type: 'RiskView' },
  'GET /api/appeals': { type: 'AppealsResponse' },
  'GET /api/blocks': { type: 'BlocksResponse' },
  'POST /api/blocks': { type: 'BlockResponse', status: 201 },
  'GET /api/campus/me': { type: 'CampusMeResponse' },
  'POST /api/campus/verification': { type: 'CampusVerificationStartResponse' },
  'POST /api/campus/verification/confirm': { type: 'CampusVerificationConfirmResponse' },
  'GET /api/campuses': { type: 'CampusesResponse' },
  'GET /api/connections': { type: 'ConnectionsResponse' },
  'PATCH /api/connections/{id}': { type: 'ReviewConnectionResponse' },
  'GET /api/conversations': { type: 'ConversationsResponse' },
  'POST /api/conversations/{id}': { type: 'SendMessageResponse', status: 201 },
  'POST /api/conversations/{id}/read': { type: 'MarkReadResponse' },
  'GET /api/dashboard': { type: 'DashboardResponse' },
  'GET /api/discover': { type: 'DiscoverResponse' },
  'GET /api/drops/today': { type: 'TodayDrops' },
  'GET /api/evidence': { type: 'EvidenceResponse' },
  'POST /api/evidence/{id}/endorse': { type: 'EndorseResponse', status: 201 },
  'GET /api/feed': { type: 'FeedResponse' },
  'GET /api/flags': { type: 'FlagsResponse' },
  'GET /api/hackathons': { type: 'HackathonsResponse' },
  'POST /api/hackathons/external': { type: 'ExternalHackathonResponse', status: 201 },
  'GET /api/hackathons/{id}/lfg': { type: 'LfgBoardResponse' },
  'GET /api/hackathons/{id}/peer-reviews': { type: 'PeerReviewTodoResponse' },
  'PATCH /api/hackathons/{id}/participation': { type: 'ParticipationResponse' },
  'POST /api/hackathons/{id}/squad-builder': { type: 'SquadProposalResponse', status: 201 },
  'GET /api/hackathons/{id}/squad-builder/{proposalId}': { type: 'SquadProposalResponse' },
  'POST /api/hackathons/{id}/squad-builder/{proposalId}/invite': { type: 'SquadInviteResponse' },
  'GET /api/health': { type: 'HealthResponse' },
  'GET /api/invites/check': { type: 'InviteCheckResponse' },
  'GET /api/invites/me': { type: 'InviteStats' },
  'POST /api/invites/redeem': { type: 'RedeemInviteResponse' },
  'GET /api/leaderboard': { type: 'LeaderboardResponse' },
  'GET /api/matches': { type: 'MatchesResponse' },
  'GET /api/messages/{id}/reactions': { type: 'MessageReactionsResponse' },
  'POST /api/messages/{id}/reactions': { type: 'ReactionResponse' },
  'GET /api/mutes': { type: 'MutesResponse' },
  'GET /api/notifications': { type: 'NotificationsResponse' },
  'GET /api/notifications/channels': { type: 'NotificationChannelsResponse' },
  'PUT /api/notifications/channels': { type: 'NotificationChannelsResponse' },
  'GET /api/notifications/push': { type: 'PushDevicesResponse' },
  'GET /api/og/link': { type: 'CardLinkResponse' },
  'GET /api/posts': { type: 'PostsPageResponse' },
  'POST /api/posts': { type: 'CreatePostResponse', status: 201 },
  'GET /api/posts/{id}/comments': { type: 'PostCommentsResponse' },
  'POST /api/posts/{id}/props': { type: 'PropsResponse', status: 201 },
  'DELETE /api/posts/{id}/props': { type: 'PropsResponse' },
  'GET /api/projects': { type: 'ProjectsResponse' },
  'GET /api/projects/{id}/milestones': { type: 'MilestonesResponse' },
  'GET /api/projects/{id}/updates': { type: 'ProjectUpdatesResponse' },
  'GET /api/quests': { type: 'QuestsResponse' },
  'GET /api/romance/interest': { type: 'RomanceInterestState' },
  'POST /api/romance/interest': { type: 'RomanceInterestState' },
  'DELETE /api/romance/interest': { type: 'RomanceInterestState' },
  'GET /api/search': { type: 'SearchResponse' },
  'GET /api/ship-day': { type: 'ShipDayResponse' },
  'POST /api/sparks': { type: 'SendSparkResponse', status: 201 },
  'GET /api/sparks/received': { type: 'ReceivedSparks' },
  'GET /api/squad-proposals': { type: 'SquadProposalsResponse' },
  'POST /api/squad-proposals/{id}/respond': { type: 'SquadProposalRespondResponse' },
  'GET /api/teams': { type: 'TeamsResponse' },
  'GET /api/teams/{id}/gaps': { type: 'TeamGapsResponse' },
  'POST /api/teams/{id}/keep-building': { type: 'KeepBuildingResponse' },
  'PUT /api/teams/{id}/pledge': { type: 'PledgeResponse' },
  'GET /api/teams/{id}/slots': { type: 'TeamSlotsResponse' },
  'GET /api/teams/{id}/space': { type: 'TeamSpaceResponse' },
  'GET /api/teams/{id}/strength': { type: 'TeamStrengthResponse' },
  'GET /api/users': { type: 'UsersResponse' },
  'GET /api/users/{id}': { type: 'ProfileResponse' },
  'GET /api/users/{id}/followers': { type: 'FollowPeopleResponse' },
  'GET /api/users/{id}/following': { type: 'FollowPeopleResponse' },
  'GET /api/users/{id}/heatmap': { type: 'HeatmapResponse' },
  'GET /api/users/{id}/posts': { type: 'PostsPageResponse' },
  'GET /api/users/{id}/stats': { type: 'PlayerCard' },
  'GET /api/users/me/consents': { type: 'ConsentsResponse' },
  'GET /api/users/me/cosmetics': { type: 'CosmeticsResponse' },
  'GET /api/users/me/export': { type: 'DataExportResponse' },
  'POST /api/users/me/export': { type: 'DataExportResponse', status: 202 },
  'GET /api/users/me/moderation': { type: 'ModerationHistoryResponse' },
  'GET /api/users/me/privacy': { type: 'PrivacySettings' },
  'PATCH /api/users/me/privacy': { type: 'PrivacySettings' },
  'GET /api/users/me/profile': { type: 'ProfileSettings' },
  'PATCH /api/users/me/profile': { type: 'ProfileSettings' },
}
