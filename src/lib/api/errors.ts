import { NextResponse } from 'next/server'
import { ROMANCE_MODE_LABEL } from '@/lib/romance/config'

// The error contract. Every API error is
//
//   { "error": { "code": "TEAM_FULL", "message": "Team is full" } }
//
// plus `params` (values the message interpolates) and `details` (structured
// extra data, such as per-field validation errors) when there are any. Clients
// branch on `code` and, for another language, render their own text from `code`
// and `params`; `message` is the English default from this catalog and is not a
// stable string to match on. Codes are never reused for a different meaning, and
// are only ever added to.
//
// Messages use `{name}` placeholders filled from `params`, which is what makes
// them translatable without parsing the English.

interface ErrorSpec {
  status: number
  message: string
}

export const ERROR_CATALOG = {
  // --- Request and authentication -------------------------------------------
  UNAUTHORIZED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do this' },
  VALIDATION_FAILED: { status: 400, message: 'Validation failed' },
  INVALID_JSON: { status: 400, message: 'The request body is not valid JSON' },
  MISSING_PARAMETER: { status: 400, message: 'Missing required parameter: {parameters}' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The request body is too large' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Try again in {retryAfter} seconds' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'The service is temporarily unavailable. Try again shortly' },
  AUTH_UNAVAILABLE: { status: 503, message: 'Authentication is temporarily unavailable' },
  ACCOUNT_CONFLICT: { status: 409, message: 'This email belongs to a different account' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong' },
  INVALID_CURSOR: { status: 400, message: 'The cursor is not valid. Start again without a cursor' },
  IDEMPOTENCY_KEY_INVALID: { status: 400, message: 'The Idempotency-Key header must be 8 to 128 letters, digits or . _ : ~ = + -' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: 'This Idempotency-Key was already used for a different request' },
  IDEMPOTENCY_REQUEST_IN_PROGRESS: { status: 409, message: 'A request with this Idempotency-Key is still being processed' },

  // --- Webhooks --------------------------------------------------------------
  WEBHOOK_NOT_CONFIGURED: { status: 503, message: 'Webhook is not configured' },
  WEBHOOK_SIGNATURE_MISSING: { status: 400, message: 'Missing signature headers' },
  WEBHOOK_SIGNATURE_INVALID: { status: 400, message: 'Invalid signature' },
  WEBHOOK_PROCESSING_FAILED: { status: 500, message: 'Processing failed' },

  // --- Realtime ---------------------------------------------------------------
  CHANNEL_FORBIDDEN: { status: 403, message: 'You cannot subscribe to one or more of these channels' },

  // --- Not found ---------------------------------------------------------------
  USER_NOT_FOUND: { status: 404, message: 'User not found' },
  REPORTED_USER_NOT_FOUND: { status: 404, message: 'Reported user not found' },
  PROJECT_NOT_FOUND: { status: 404, message: 'Project not found' },
  PROJECT_NOT_OWNED: { status: 404, message: 'Project not found or not owned by you' },
  MILESTONE_NOT_FOUND: { status: 404, message: 'Milestone not found' },
  UPDATE_NOT_FOUND: { status: 404, message: 'Update not found' },
  TEAM_NOT_FOUND: { status: 404, message: 'Team not found' },
  MEMBER_NOT_FOUND: { status: 404, message: 'Member not found' },
  APPLICATION_NOT_FOUND: { status: 404, message: 'Application not found' },
  APPLICATION_NOT_PENDING: { status: 404, message: 'Application not found or already resolved' },
  HACKATHON_NOT_FOUND: { status: 404, message: 'Hackathon not found' },
  TEAM_NOT_IN_HACKATHON: { status: 404, message: 'This team is not registered for this hackathon' },
  CONNECTION_NOT_FOUND: { status: 404, message: 'Connection not found' },
  CONVERSATION_NOT_FOUND: { status: 404, message: 'Conversation not found' },
  MESSAGE_NOT_FOUND: { status: 404, message: 'Message not found' },
  NOTIFICATION_NOT_FOUND: { status: 404, message: 'Notification not found' },
  EVIDENCE_NOT_FOUND: { status: 404, message: 'Evidence not found' },
  SKILL_NOT_FOUND: { status: 404, message: 'Skill not found' },
  USER_SKILL_NOT_FOUND: { status: 404, message: 'Skill not found for user' },
  REPORT_NOT_FOUND: { status: 404, message: 'Report not found' },
  BUILD_NOT_FOUND: { status: 404, message: 'No current build found' },
  FLAG_NOT_FOUND: { status: 404, message: 'Feature flag not found' },
  SETTING_NOT_FOUND: { status: 404, message: 'Setting not found' },

  // --- People ------------------------------------------------------------------
  USER_BLOCKED: { status: 403, message: 'You have blocked this user' },
  CANNOT_BLOCK_SELF: { status: 400, message: 'You cannot block yourself' },
  CANNOT_CONNECT_SELF: { status: 400, message: 'You cannot connect with yourself' },
  CANNOT_REPORT_SELF: { status: 400, message: 'You cannot report yourself' },
  CANNOT_ENDORSE_OWN_EVIDENCE: { status: 403, message: 'You cannot endorse your own evidence' },
  USERS_NOT_FOUND: { status: 400, message: 'One or more users were not found' },

  // --- Connections and reports --------------------------------------------------
  CONNECTION_EXISTS: { status: 400, message: 'Already connected with this user' },
  CONNECTION_PENDING: { status: 409, message: 'A connection request is already pending between you and this user' },
  CONNECTION_ALREADY_RESOLVED: { status: 400, message: 'Connection is already {status}' },
  REPORT_ALREADY_PENDING: { status: 409, message: 'You already have a pending report against this user' },
  REPORT_INVALID_TRANSITION: { status: 400, message: 'Cannot transition report from {from} to {to}' },

  // --- Messaging -----------------------------------------------------------------
  DIRECT_CONVERSATION_PARTICIPANTS: { status: 400, message: 'Direct conversations require exactly 1 participant' },
  READ_MARKER_NOT_IN_CONVERSATION: { status: 400, message: 'upToMessageId does not belong to this conversation' },
  MESSAGE_DELETED: { status: 400, message: 'This message has been deleted' },
  REACTION_LIMIT_PER_USER: { status: 400, message: 'You can add at most {max} different reactions to one message' },
  REACTION_LIMIT_PER_MESSAGE: { status: 400, message: 'A message can have at most {max} different reactions' },

  // --- Skills and evidence ---------------------------------------------------------
  SKILL_ALREADY_ADDED: { status: 400, message: 'Skill already added' },
  EVIDENCE_SKILL_NOT_ON_PROFILE: { status: 400, message: 'You can only attach evidence to a skill you have added to your profile' },
  EVIDENCE_LIMIT_REACHED: { status: 400, message: 'You can attach at most {max} pieces of evidence to one skill' },

  // --- Projects --------------------------------------------------------------------
  MILESTONE_LIMIT_REACHED: { status: 400, message: 'A project can have at most {max} milestones' },
  SYSTEM_UPDATE_IMMUTABLE: { status: 400, message: 'System-generated updates cannot be edited' },
  PROJECT_HAS_TEAM: { status: 400, message: 'Project already has a team' },

  // --- Teams ------------------------------------------------------------------------
  NOT_TEAM_MEMBER: { status: 403, message: 'Not a team member' },
  ALREADY_TEAM_MEMBER: { status: 400, message: 'Already a member of this team' },
  TEAM_FULL: { status: 400, message: 'Team is full' },
  TEAM_PROJECT_FULL: { status: 400, message: "This team's linked project is already at its max team size" },
  TEAM_NOT_RECRUITING: { status: 400, message: 'Team is not recruiting' },
  ALREADY_APPLIED: { status: 400, message: 'Already applied to this team' },
  APPLICATION_ALREADY_REVIEWED: { status: 400, message: 'Application already reviewed' },
  INVITATION_PENDING: { status: 409, message: 'An invitation to this user is already pending' },
  APPLICATION_PENDING: { status: 409, message: 'This user already has a pending application to this team' },
  CANNOT_REMOVE_OWNER: { status: 403, message: 'Cannot remove team owner' },
  SOLE_OWNER_CANNOT_LEAVE: { status: 400, message: "Cannot leave: you're the sole owner. Promote another member or delete the team first" },
  ALREADY_OWNER: { status: 400, message: 'That user is already the owner' },
  NEW_OWNER_NOT_MEMBER: { status: 400, message: 'The new owner must already be a team member' },

  // --- Platform ----------------------------------------------------------------------
  FLAG_EXISTS: { status: 409, message: 'A feature flag with this key already exists' },
  JOB_NOT_FOUND: { status: 404, message: 'No such job' },

  // --- Cosmetics -------------------------------------------------------------------------------------
  COSMETIC_NOT_OWNED: { status: 403, message: 'You have not earned this cosmetic' },
  COSMETIC_WRONG_SLOT: { status: 400, message: 'This cosmetic does not go in that slot' },

  // --- Matching ----------------------------------------------------------------------------
  DATING_BIRTH_DATE_REQUIRED: { status: 403, message: 'Add your date of birth in your profile settings to use {mode}' },
  DATING_UNDERAGE: { status: 403, message: '{mode} is only available to people who are 18 or older' },
  DATING_VERIFICATION_REQUIRED: { status: 403, message: '{mode} needs a verified email and either a verified phone number or a connected GitHub account' },
  BIRTH_DATE_LOCKED: { status: 409, message: 'Your date of birth is already set and cannot be changed' },
  AGE_BELOW_MINIMUM: { status: 403, message: 'You need to be at least {minAge} to use Skill Dating' },
  BIRTH_DATE_REQUIRED: { status: 400, message: 'Your date of birth is required' },
  CARDS_NOT_AVAILABLE: { status: 400, message: 'Share cards on the web are for accounts that are 18 or older with a date of birth on file' },
  MINOR_LOCATION_LIMITED: { status: 400, message: 'Accounts for people under 18 can share a country, not a city, campus or place' },
  BIRTHDATE_CORRECTION_SELF_ONLY: { status: 400, message: 'A date of birth correction is a request about your own account' },
  DROP_NOT_FOUND: { status: 404, message: 'Drop not found' },
  DROP_NOT_PENDING: { status: 409, message: 'This drop has already been answered or has expired' },
  CANNOT_SPARK_SELF: { status: 400, message: 'You cannot spark yourself' },
  MATCHING_PROFILE_REQUIRED: { status: 400, message: 'Set up your matching profile first' },
  SPARK_TYPE_NOT_CHOSEN: { status: 400, message: 'You have not chosen this type of connection in your matching profile' },
  SPARK_TARGET_UNAVAILABLE: { status: 404, message: 'This person is not available to spark' },
  SPARK_ALREADY_SENT: { status: 409, message: 'You have already sparked this person for this type of connection' },
  SPARK_OPENER_REJECTED: { status: 400, message: 'That opener cannot be sent' },
  SPARK_LIMIT_REACHED: { status: 429, message: 'You have used all {limit} of your sparks for today. More arrive tomorrow' },
  SPARK_THROTTLED: { status: 429, message: 'You are sending sparks too fast. Try again in a little while' },
  ROMANCE_PROFILE_REQUIRED: { status: 400, message: 'Join {mode} first' },
  ROMANCE_ACCOUNT_TOO_NEW: { status: 403, message: 'Your account needs to be a week old, with a verified email, to send a {mode} spark' },
  ROMANCE_SPARK_LIMIT_REACHED: { status: 429, message: 'You have used all {limit} of your {mode} sparks for this week. More arrive on Monday' },
  ROMANCE_PHOTO_LIMIT: { status: 400, message: 'You can have at most 6 photos' },
  DUO_BUSY: { status: 409, message: 'One of you is already in a Duo. Dissolve it first' },
  MATCH_NOT_FOUND: { status: 404, message: 'Match not found' },
  MATCH_EXISTS: { status: 409, message: 'You are already matched with this person' },
  MATCH_ENDED: { status: 409, message: 'This match has ended and cannot be started again' },
  CONVERSATION_CLOSED: { status: 409, message: 'This conversation has been closed' },

  // --- Media ----------------------------------------------------------------------------
  STORAGE_UNAVAILABLE: { status: 503, message: 'Uploads are not available right now' },
  MEDIA_NOT_FOUND: { status: 404, message: 'Media not found' },
  MEDIA_INVALID: { status: 400, message: 'That file cannot be uploaded' },
  MEDIA_PENDING_LIMIT: { status: 429, message: 'You have too many unfinished uploads. Finish or wait for them to expire' },
  MEDIA_NOT_UPLOADED: { status: 409, message: 'The file has not been uploaded yet' },
  MEDIA_MISMATCH: { status: 422, message: 'The uploaded file is not what was declared' },

  // --- Posts, Props, comments, follows ------------------------------------------------------
  POST_NOT_FOUND: { status: 404, message: 'Post not found' },
  POST_INVALID_CONTEXT: { status: 400, message: 'The project or crew does not fit this post' },
  POST_COAUTHOR_NOT_MEMBER: { status: 400, message: 'Co-authors must be members of the project or crew' },
  CANNOT_PROP_OWN_POST: { status: 403, message: 'You cannot give Props to your own post' },
  COMMENT_NOT_FOUND: { status: 404, message: 'Comment not found' },
  COMMENT_REPLY_DEPTH: { status: 400, message: 'You can reply to a comment, not to a reply' },
  COMMENT_EDIT_WINDOW_CLOSED: { status: 403, message: 'A comment can only be edited for {minutes} minutes after it is posted' },
  CANNOT_FOLLOW_SELF: { status: 400, message: 'You cannot follow yourself' },

  // --- Hackathons ---------------------------------------------------------------------
  HACKATHON_REGISTRATION_REQUIRED: { status: 400, message: 'You must be registered for this hackathon' },
  HACKATHON_ALREADY_REGISTERED: { status: 400, message: 'Already registered' },
  HACKATHON_REGISTRATION_CLOSED: { status: 400, message: 'Registration closed' },
  HACKATHON_REGISTRATION_DEADLINE_PASSED: { status: 400, message: 'Registration deadline passed' },
  HACKATHON_INVALID_TRANSITION: { status: 400, message: 'Cannot transition hackathon from {from} to {to}' },
  HACKATHON_NOT_ENDED: { status: 400, message: 'Results can only be recorded once the hackathon has ended' },
  HACKATHON_SUBMISSIONS_CLOSED: { status: 400, message: 'Submissions are only open while the hackathon is active' },
  HACKATHON_TEAM_MISMATCH: { status: 400, message: 'One or more teams do not belong to this hackathon' },
  HACKATHON_TEAM_REGISTRATION_CLOSED: { status: 400, message: 'Team registration closed' },
  ALREADY_IN_HACKATHON_TEAM: { status: 400, message: 'Already in a team for this hackathon' },
  TEAM_WRONG_HACKATHON: { status: 400, message: 'Team belongs to a different hackathon' },
  TEAM_NO_PROJECT: { status: 400, message: 'This team has no linked project to submit' },
  HACKATHON_TEAM_TOO_LARGE: { status: 400, message: "Team exceeds this hackathon's max team size of {max}" },
  HACKATHON_TEAM_TOO_SMALL: { status: 400, message: "Team is below this hackathon's min team size of {min}" },

  // --- Squads ------------------------------------------------------------------
  SLOT_NOT_FOUND: { status: 404, message: 'Slot not found' },
  SLOT_NOT_OPEN: { status: 409, message: 'This slot is not open' },
  SLOT_LIMIT_REACHED: { status: 400, message: 'A team cannot have more open slots than free places ({free})' },
  TEAM_LOCKED: { status: 409, message: "The team is locked: the hackathon's submission deadline has passed" },
  INVITATION_EXPIRED: { status: 410, message: 'This invitation has expired' },
  SQUAD_COMPLETE: { status: 409, message: 'Your squad is already full' },
  SQUAD_POOL_EMPTY: { status: 422, message: 'Nobody in the pool for this hackathon can join a squad right now' },
  TRACK_NOT_FOUND: { status: 400, message: 'This hackathon has no track called {tracks}' },
  SQUAD_PROPOSAL_NOT_FOUND: { status: 404, message: 'Squad proposal not found' },
  SQUAD_PROPOSAL_USED: { status: 409, message: 'This squad proposal has already been used' },
  SQUAD_PROPOSAL_EXPIRED: { status: 410, message: 'This squad proposal has expired' },
  LFG_POST_NOT_FOUND: { status: 404, message: 'Looking-for-group post not found' },
  LFG_ACTIVE_POST_EXISTS: { status: 409, message: 'You already have an active post on this board' },
  CHECKLIST_ITEM_NOT_FOUND: { status: 404, message: 'Checklist item not found' },
  IDEA_NOT_FOUND: { status: 404, message: 'Idea not found' },
  TEAM_SPACE_LIMIT: { status: 400, message: 'A team can have at most {max} {what}' },
  NOT_A_HACKATHON_TEAM: { status: 400, message: 'This team was not registered for a hackathon' },
  KEEP_BUILDING_TOO_EARLY: { status: 409, message: 'A squad can keep building once the results are in or the hackathon is over' },
  KEEP_BUILDING_DONE: { status: 409, message: 'This squad is already a crew' },
  ACCOUNT_NOT_TRUSTED: { status: 403, message: 'Your account needs to be a week old, with a verified email, to do this' },
  EXTERNAL_URL_REFUSED: { status: 400, message: 'This link cannot be used: it must be a public http or https page' },
  EXTERNAL_PAGE_UNREADABLE: { status: 422, message: 'The page at this link could not be read ({reason})' },
  PLEDGE_CLOSED: { status: 409, message: 'Pledges can be made until the hackathon starts' },
  PLEDGE_DATES_OUTSIDE: { status: 400, message: "The pledged dates must be within the hackathon's dates" },
  PEER_REVIEW_WINDOW_CLOSED: { status: 409, message: 'Peer reviews are open for a week after the results or the end of the hackathon' },
  PEER_REVIEW_EXISTS: { status: 409, message: 'You have already reviewed this teammate for this hackathon' },
  NOT_TEAMMATES: { status: 403, message: 'You can only review your own teammates' },
  EXTERNAL_DATES_UNKNOWN: { status: 422, message: 'The page does not say when the hackathon runs: send startDate and endDate' },

  // --- Trust, safety and privacy (docs/SAFETY.md, docs/PRIVACY.md, docs/SECURITY.md) ----------------------------
  EMAIL_VERIFICATION_REQUIRED: { status: 403, message: 'Verify your email address first' },
  CONTENT_REJECTED: { status: 400, message: 'This cannot be sent as written ({reasons})' },
  FEATURE_RESTRICTED: { status: 403, message: 'You cannot use {feature} right now' },
  ACCOUNT_SUSPENDED: { status: 403, message: 'Your account is suspended' },
  ACCOUNT_BANNED: { status: 403, message: 'Your account has been banned' },
  REPORT_TARGET_NOT_FOUND: { status: 404, message: 'The reported content was not found' },
  MODERATION_ACTION_NOT_FOUND: { status: 404, message: 'Moderation action not found' },
  MODERATION_ACTION_INVALID: { status: 400, message: 'This action cannot be taken on this {target}' },
  APPEAL_NOT_FOUND: { status: 404, message: 'Appeal not found' },
  APPEAL_NOT_ALLOWED: { status: 409, message: 'This action cannot be appealed' },
  APPEAL_EXISTS: { status: 409, message: 'You have already appealed this action' },
  APPEAL_ALREADY_DECIDED: { status: 409, message: 'This appeal has already been decided' },
  CANNOT_MUTE_SELF: { status: 400, message: 'You cannot mute yourself' },
  FRAUD_SIGNAL_NOT_FOUND: { status: 404, message: 'Fraud signal not found' },
  REAUTH_REQUIRED: { status: 403, message: 'Sign in again to do this: it needs a session started in the last {maxAgeMinutes} minutes' },
  SIGNUPS_PAUSED: { status: 503, message: 'New accounts are paused for a short while. Try again later' },
  ROMANCE_PAUSED: { status: 503, message: '{mode} is not open for you yet' },
  ROMANCE_ALREADY_OPEN: { status: 409, message: '{mode} is already open for you' },
  MESSAGING_PAUSED: { status: 503, message: 'Messaging is paused for a short while. Try again later' },
  POSTING_PAUSED: { status: 503, message: 'Posting is paused for a short while. Try again later' },
  EXTERNAL_HACKATHONS_PAUSED: { status: 503, message: 'Adding hackathons from other sites is paused for a short while' },
  SIGNUP_EMAIL_REJECTED: { status: 403, message: 'Sign up with a permanent email address' },
  SIGNUP_RATE_LIMITED: { status: 429, message: 'Too many new accounts from this network. Try again later' },
  NAME_RESERVED: { status: 400, message: 'This name cannot be used' },
  CONSENT_REQUIRED: { status: 403, message: 'Accept the current {documents} to continue' },
  ROMANCE_CONSENT_REQUIRED: { status: 403, message: 'Agree to how {mode} uses your data to turn it on' },
  CONSENT_VERSION_UNKNOWN: { status: 400, message: 'That is not the current version of the {document}' },
  EXPORT_NOT_FOUND: { status: 404, message: 'Export not found' },
  EXPORT_IN_PROGRESS: { status: 409, message: 'An export of your data is already being prepared' },
  EXPORT_EXPIRED: { status: 410, message: 'This export has expired. Ask for a new one' },
  MEDIA_SCANNING_UNAVAILABLE: { status: 503, message: 'Photo uploads are not available right now' },
  MESSAGING_NOT_ALLOWED: { status: 403, message: 'This person does not accept messages from you' },
  ROMANCE_PROFILE_HIDDEN: { status: 409, message: 'Your profile was hidden by a moderator and cannot be shown until they review it' },

  // --- Reach and retention (docs/NOTIFICATIONS.md) -----------------------------
  PUSH_ENDPOINT_NOT_ALLOWED: { status: 400, message: 'This push endpoint is not accepted' },
  PUSH_DEVICE_LIMIT: { status: 409, message: 'You can register at most {max} devices for push. Remove one first' },
  PUSH_DEVICE_NOT_FOUND: { status: 404, message: 'Push device not found' },
  DELIVERY_NOT_FOUND: { status: 404, message: 'Notification delivery not found' },
  UNSUBSCRIBE_LINK_INVALID: { status: 400, message: 'This unsubscribe link is not valid' },
  CARD_NOT_FOUND: { status: 404, message: 'This share card does not exist' },
  INVITE_CODE_INVALID: { status: 404, message: 'This invite code does not exist or can no longer be used' },
  INVITE_ALREADY_REDEEMED: { status: 409, message: 'This account already joined with an invite code' },
  INVITE_OWN_CODE: { status: 400, message: 'You cannot use your own invite code' },
  INVITE_WINDOW_CLOSED: { status: 409, message: 'An invite code can only be used in the first {days} days of an account' },
  INVITE_CODE_TAKEN: { status: 409, message: 'An invite code with this text already exists' },
  INVITE_NOT_FOUND: { status: 404, message: 'Invite code not found' },
  CAMPUS_NOT_FOUND: { status: 404, message: 'Campus not found' },
  CAMPUS_SLUG_TAKEN: { status: 409, message: 'A campus with this name already exists' },
  CAMPUS_EMAIL_INVALID: { status: 400, message: 'Use an e-mail address on one of these domains: {domains}' },
  CAMPUS_EMAIL_IN_USE: { status: 409, message: 'This campus e-mail address is already verified on another account' },
  CAMPUS_CODE_INVALID: { status: 400, message: 'That code is not right. {remaining} tries left' },
  CAMPUS_CODE_EXPIRED: { status: 410, message: 'That code has expired. Ask for a new one' },
  CAMPUS_VERIFICATION_NOT_FOUND: { status: 404, message: 'There is no campus verification in progress' },
  CAMPUS_IS_VERIFIED: { status: 409, message: 'Your campus is verified. Leave it before changing it' },
  CAMPUS_CLOSED: { status: 409, message: 'This campus is not taking new members' },

  // --- Proof: the evidence engine and receipts (docs/PROOF.md) ----------------------
  RECEIPT_NOT_FOUND: { status: 404, message: 'This receipt does not exist' },
  RECEIPT_REVOKED: { status: 410, message: 'This receipt was revoked' },
  RECEIPTS_PAUSED: { status: 503, message: 'Receipt pages are paused for a short while' },
  EVIDENCE_ENGINE_PAUSED: { status: 503, message: 'Reading GitHub history is paused for a short while' },
  GITHUB_NOT_CONNECTED: { status: 409, message: 'Connect a GitHub account first' },
  GITHUB_SYNC_CONSENT_REQUIRED: { status: 403, message: 'Allow reading your public GitHub history first (the GITHUB_SYNC consent)' },
  CLAIM_NOT_FOUND: { status: 404, message: 'This claim does not exist' },
  DISPUTE_NOT_ALLOWED: { status: 403, message: 'Only someone with authored work in this repository can dispute a claim to it' },
} as const satisfies Record<string, ErrorSpec>

export type ErrorCode = keyof typeof ERROR_CATALOG

export type ErrorParams = Record<string, string | number | boolean>

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    params?: ErrorParams
    details?: unknown
  }
}

export interface ErrorOptions {
  /** Values for the `{placeholders}` in the message. Sent to the client too, for translation. */
  params?: ErrorParams
  /** Structured extra data: field errors, the conflicting record, and so on. */
  details?: unknown
  headers?: Record<string, string>
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value)
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_CATALOG[code].status
}

/** The English default for a code, with `{placeholders}` filled in. A missing param is left visible. */
export function errorMessage(code: ErrorCode, params: ErrorParams = {}): string {
  // {mode} is the romance mode's name wherever a message says it, so renaming the mode is one constant (src/lib/romance/config.ts).
  const all: ErrorParams = { mode: ROMANCE_MODE_LABEL, ...params }
  return ERROR_CATALOG[code].message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in all ? String(all[name]) : placeholder
  )
}

export function errorBody(code: ErrorCode, { params, details }: ErrorOptions = {}): ApiErrorBody {
  const hasParams = params !== undefined && Object.keys(params).length > 0
  return {
    error: {
      code,
      message: errorMessage(code, params),
      ...(hasParams ? { params } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  }
}

export function errorResponse(code: ErrorCode, options: ErrorOptions = {}): NextResponse<ApiErrorBody> {
  return NextResponse.json(errorBody(code, options), {
    status: errorStatus(code),
    ...(options.headers ? { headers: options.headers } : {}),
  })
}
