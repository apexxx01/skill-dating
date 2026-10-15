import { NextResponse } from 'next/server'

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
  return ERROR_CATALOG[code].message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder
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
