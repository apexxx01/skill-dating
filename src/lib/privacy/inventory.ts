// The data inventory: every table that holds something about a person, what an export gives them, and what deleting the account does to it (docs/PRIVACY.md
// is written from this table). A unit test (inventory.test.ts) reads the Prisma schema and fails when a model that points at User, or a column that
// holds user ids, is missing here, so a table cannot be added without deciding what happens to it.
//
// Deletion (src/lib/privacy/delete.ts) keeps the User row, anonymised (docs/AUTH_MIGRATION.md): deleting it would cascade through work other people share.
//   DELETE    the rows are removed.
//   SCRUB     the rows stay for others (a thread keeps its shape) but are hidden and their text blanked.
//   KEEP      the rows stay, attributed to the anonymised account, because other people depend on them or the law asks for them (the reason says which).
//   SET_NULL  the link to the person is cleared and the row kept (counts stay right, the person is gone).
//   CUSTOM    a step of its own (deletion.ts names it).
// Export (src/lib/privacy/export.ts):
//   FULL      every column of the rows that point at the person.
//   REDACTED  as FULL without the listed columns (other people's identity or private notes, internal scores).
//   NONE      not exported (the reason says why).

export type DeletionRule = 'DELETE' | 'SCRUB' | 'KEEP' | 'SET_NULL' | 'CUSTOM'
export type ExportRule = 'FULL' | 'REDACTED' | 'NONE'

export interface InventoryEntry {
  /** The columns that hold the person's id, with what deleting the account does through each. */
  fields: Record<string, DeletionRule>
  export: ExportRule
  /** Columns left out of the export (REDACTED). */
  redact?: string[]
  /** The columns the export reads rows through, when not all of `fields`: rows where the person is only the other side (somebody else's drop showing
   *  them, a spark sent to them, a block against them) belong to the other person and are not exported. */
  exportVia?: string[]
  /** Why: what the data is, and the reason for a KEEP, a NONE or a redaction. */
  note: string
}

export const DATA_INVENTORY: Record<string, InventoryEntry> = {
  User: { fields: { id: 'CUSTOM' }, export: 'REDACTED', redact: ['passwordHash'], note: 'the account: anonymised and marked deleted; the date of birth is wiped' },
  Account: { fields: { userId: 'DELETE' }, export: 'REDACTED', redact: ['access_token', 'refresh_token', 'id_token', 'session_state'], note: 'legacy sign-in links (tokens are secrets, never exported)' },
  Session: { fields: { userId: 'DELETE' }, export: 'NONE', note: 'legacy sessions: secrets' },
  Profile: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'the passport: bio, links, place, privacy settings' },
  UserSkill: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'skills on the passport' },
  SkillEvidence: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'evidence on the passport and the endorsements received on it (endorsements the person gave belong to the endorsed person)' },
  Project: { fields: { ownerId: 'KEEP' }, export: 'FULL', note: 'projects are shared work: other members and posts point at them' },
  ProjectMember: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'membership of shared projects' },
  ProjectUpdate: { fields: { authorId: 'KEEP' }, export: 'FULL', note: 'updates on shared projects' },
  Team: { fields: { ownerId: 'KEEP' }, export: 'FULL', note: 'crews and squads are shared' },
  TeamMember: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'membership of shared crews' },
  TeamApplication: { fields: { userId: 'DELETE', invitedById: 'SET_NULL' }, export: 'FULL', note: 'applications and invitations' },
  TeamSlot: { fields: { filledById: 'KEEP' }, export: 'FULL', note: 'a squad slot the person filled: the squad keeps its shape' },
  Hackathon: { fields: { submittedById: 'SET_NULL' }, export: 'FULL', note: 'external hackathons the person submitted: public listings' },
  HackathonParticipant: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'registrations: hackathon history and results' },
  HackathonTeamMember: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'squad history: other members’ results depend on it' },
  ChallengeAttempt: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'challenge attempts' },
  UserAchievement: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'achievements' },
  UserCounter: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'progress counters' },
  ProgressTick: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'progress history' },
  UserCosmetic: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'cosmetics owned' },
  XPEvent: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'the XP log: leaderboards and season standings are rebuilt from it (a deleted account is left out of every board)' },
  SeasonStanding: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'final standings of closed seasons: others’ ranks depend on them' },
  ReputationEvent: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'reputation history' },
  Connection: { fields: { senderId: 'DELETE', receiverId: 'DELETE' }, export: 'FULL', note: 'connections' },
  ConversationMember: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'conversation membership: the other people keep the conversation' },
  Message: { fields: { senderId: 'KEEP' }, export: 'FULL', note: 'messages sent: part of the other people’s conversations, shown as from a deleted account (messages received are the senders’ data)' },
  MessageReaction: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'reactions' },
  MessageRead: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'read markers' },
  Notification: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'notifications' },
  NotificationPreference: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'notification switches' },
  PushSubscription: { fields: { userId: 'DELETE' }, export: 'REDACTED', redact: ['p256dh', 'auth'], note: 'browsers registered for web push (the keys the pushes are encrypted to are secrets, never exported)' },
  NotificationSettings: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'delivery settings: email and push switches, quiet hours, digests' },
  ChannelPreference: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'which kinds of notification reach the person by email or push' },
  InviteCode: { fields: { ownerId: 'DELETE', createdById: 'SET_NULL' }, export: 'FULL', exportVia: ['ownerId'], note: 'the person’s own invite code (campaign codes belong to the platform; the admin who made one is unlinked)' },
  InviteRedemption: { fields: { inviteeId: 'DELETE', inviterId: 'SET_NULL' }, export: 'FULL', exportVia: ['inviteeId'], note: 'which invite code the person joined with (who joined with theirs is other people’s data); an inviter’s deletion unlinks them and keeps the attribution' },
  Campus: { fields: { createdById: 'SET_NULL' }, export: 'NONE', note: 'a college’s record, managed by admins: reference data, not about a person; the admin who made it is unlinked' },
  RomanceInterest: { fields: { userId: 'DELETE' }, export: 'FULL', note: '"tell me when it opens" for the romance mode: the request and the country and city it was counted under; removed by DELETE /api/romance/interest and with the account' },
  CampusMembership: { fields: { userId: 'DELETE' }, export: 'REDACTED', redact: ['emailHash'], note: 'the campus the person verified (the campus e-mail address itself is never kept, only a keyed hash that cannot be reversed)' },
  CampusVerification: { fields: { userId: 'DELETE' }, export: 'NONE', note: 'a campus verification in progress: holds the campus e-mail address until the code is confirmed or expires, then it is erased' },
  ActivityDay: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'the days (UTC) the person did something of their own: what retention and active counts are made from, kept 25 months' },
  NotificationDelivery: { fields: { userId: 'DELETE' }, export: 'REDACTED', redact: ['providerId'], note: 'what was emailed or pushed and when (no content); deleted after 90 days anyway' },
  Report: { fields: { reporterId: 'KEEP', reportedId: 'KEEP' }, export: 'REDACTED', redact: ['reporterId', 'metadata', 'priority', 'snapshot'], note: 'moderation records: kept for safety and legal holds, deleted 2 years after they are resolved; who reported someone is never exported' },
  ModerationAction: { fields: { moderatorId: 'KEEP', subjectUserId: 'KEEP', reversedById: 'KEEP' }, export: 'REDACTED', redact: ['moderatorId', 'reason', 'metadata', 'reversedById'], note: 'moderation decisions: the person sees the category, the note to them and the dates; the moderator and their notes are not exported' },
  Appeal: { fields: { userId: 'KEEP', decidedById: 'KEEP' }, export: 'REDACTED', redact: ['decidedById'], note: 'appeals: moderation records' },
  UserRestriction: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'restrictions: moderation records' },
  Mute: { fields: { muterId: 'DELETE', mutedId: 'DELETE' }, export: 'FULL', exportVia: ['muterId'], note: 'people the person muted (who muted them is not exported)' },
  AuditEvent: { fields: { userId: 'KEEP' }, export: 'NONE', note: 'the security audit trail: kept for incident response and legal duties; not part of the export because it names staff and other accounts' },
  Verification: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'verification records' },
  CurrentBuild: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'the current build on the passport' },
  UserQuest: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'quests' },
  Activity: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'the activity log' },
  Block: { fields: { blockerId: 'DELETE', blockedId: 'DELETE' }, export: 'FULL', exportVia: ['blockerId'], note: 'people the person blocked (who blocked them is not exported)' },
  LeaderboardEntry: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'leaderboard snapshots' },
  Subscription: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'billing records: kept as tax and accounting law requires' },
  ProductEvent: { fields: { userId: 'SET_NULL' }, export: 'FULL', note: 'product analytics: the counts stay, the link to the person goes; deleted after 13 months anyway' },
  MatchingProfile: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'matching preferences' },
  Drop: { fields: { userId: 'DELETE', candidateId: 'DELETE' }, export: 'REDACTED', redact: ['score'], exportVia: ['userId'], note: 'daily drops shown to the person (the people shown, and drops where the person was shown to someone, are other people’s)' },
  Spark: { fields: { fromId: 'DELETE', toId: 'DELETE' }, export: 'REDACTED', redact: ['openerHash'], exportVia: ['fromId'], note: 'sparks sent (sparks received are the senders’ data, shown in the app as the person’s plan allows)' },
  Match: { fields: { userAId: 'CUSTOM', userBId: 'CUSTOM', endedById: 'KEEP' }, export: 'FULL', note: 'matches: open ones are ended; the row stays for the other person’s history' },
  RevealRequest: { fields: { revokedById: 'KEEP' }, export: 'NONE', note: 'romance photo reveal state: removed with the romance data (CUSTOM via the match)' },
  BuildDate: { fields: { proposedById: 'KEEP' }, export: 'NONE', note: 'romance build dates (not in use yet): removed with the romance data' },
  MediaAsset: { fields: { ownerId: 'CUSTOM' }, export: 'REDACTED', redact: ['key'], note: 'uploads: rows and the objects in the bucket are deleted' },
  RomanceProfile: { fields: { userId: 'CUSTOM' }, export: 'FULL', note: 'the romance profile and private filters: deleted with photos, drops and reveal state (special-category data)' },
  RomanceDrop: { fields: { userId: 'CUSTOM', candidateId: 'CUSTOM' }, export: 'REDACTED', redact: ['score'], exportVia: ['userId'], note: 'romance drops: deleted with the romance data' },
  Duo: { fields: { userAId: 'CUSTOM', userBId: 'CUSTOM', requestedById: 'KEEP', dissolvedById: 'KEEP' }, export: 'FULL', note: 'romance duos: dissolved with the romance data' },
  ShipPost: { fields: { authorId: 'SCRUB', coAuthorIds: 'CUSTOM' }, export: 'FULL', note: 'posts: hidden and blanked (comments under them keep their thread); the person is taken off others’ posts as a co-author' },
  Prop: { fields: { userId: 'CUSTOM' }, export: 'FULL', note: 'Props given: deleted, and the posts’ scores recomputed' },
  Comment: { fields: { authorId: 'SCRUB' }, export: 'FULL', note: 'comments: hidden and blanked, so replies keep their thread' },
  Follow: { fields: { followerId: 'DELETE', followeeId: 'DELETE' }, export: 'FULL', note: 'follows' },
  Watch: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'watched projects' },
  SquadProposal: { fields: { requesterId: 'SET_NULL' }, export: 'FULL', note: 'squad builder proposals: shared with the proposed members' },
  SquadProposalMember: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'seats in proposed squads' },
  LfgPost: { fields: { authorId: 'DELETE' }, export: 'FULL', note: 'looking-for-group posts' },
  TeamChecklistItem: { fields: { assigneeId: 'SET_NULL', createdById: 'KEEP' }, export: 'FULL', note: 'a squad’s shared checklist' },
  TeamIdea: { fields: { authorId: 'KEEP' }, export: 'FULL', note: 'a squad’s shared idea board' },
  TeamIdeaVote: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'votes on a squad’s ideas: the board’s counts stay right' },
  CommitmentPledge: { fields: { userId: 'DELETE' }, export: 'FULL', note: 'hackathon pledges' },
  PeerReview: { fields: { reviewerId: 'CUSTOM', revieweeId: 'DELETE' }, export: 'REDACTED', redact: ['reviewerId', 'note', 'integrityWeight', 'counted'], note: 'reviews given stay (teammates’ reliability depends on them) with their private note blanked; reviews received are deleted; who wrote a review is never exported' },
  UserReliability: { fields: { userId: 'DELETE' }, export: 'NONE', note: 'an internal score, never shown as a number; deleted' },
  UserRisk: { fields: { userId: 'DELETE', overrideById: 'KEEP' }, export: 'NONE', note: 'an internal safety score; deleted (the audit trail keeps its changes)' },
  DataExport: { fields: { userId: 'CUSTOM' }, export: 'NONE', note: 'export requests: the files and rows are deleted' },
  ConsentRecord: { fields: { userId: 'KEEP' }, export: 'FULL', note: 'proof of consent and of its withdrawal: kept as the legal record of the basis for past processing' },
  Report_resolvedBy: { fields: { resolvedById: 'KEEP' }, export: 'NONE', note: 'the moderator who resolved a report (Report.resolvedById)' },
  FeatureFlag: { fields: { allowUserIds: 'CUSTOM', updatedById: 'KEEP' }, export: 'NONE', note: 'early-access allowlists: the person is taken off every list' },
  IntegritySignal: { fields: { userId: 'SET_NULL' }, export: 'NONE', note: 'integrity signals: internal; the link to the person is cleared' },
  FraudSignal: { fields: { memberIds: 'KEEP', reviewedById: 'KEEP' }, export: 'NONE', note: 'collusion findings: internal evidence, kept as ids of an anonymised account' },
}

/** Pairs of (model, field) the inventory covers, with the model name a pseudo-entry like Report_resolvedBy stands for. */
export function inventoryFields(): Map<string, DeletionRule> {
  const out = new Map<string, DeletionRule>()
  for (const [name, entry] of Object.entries(DATA_INVENTORY)) {
    const model = name.split('_')[0]
    for (const [field, rule] of Object.entries(entry.fields)) out.set(`${model}.${field}`, rule)
  }
  return out
}
