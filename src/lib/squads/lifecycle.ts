// The squad lifecycle's clocks and limits (docs/SQUADS.md, "Lifecycle and safety rails").

const HOUR_MS = 60 * 60 * 1000

/** An invitation to a team is good for this long. */
export const INVITATION_TTL_MS = 48 * HOUR_MS

/** A squad builder proposal can be turned into invitations for this long; an automatic squad's members have this long to answer. */
export const PROPOSAL_TTL_MS = 24 * HOUR_MS
