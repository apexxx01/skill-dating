import type { PostKind } from '@prisma/client'

// How many co-authors a post may name. A DEMO post credits a hackathon squad, so it may name as many people as the hackathon allows in a team, up to a
// hard cap; every other kind keeps the general limit.

/** The co-author limit for every kind of post but a squad's DEMO. */
export const DEFAULT_CO_AUTHOR_LIMIT = 5
/** The most co-authors any post may name, whatever the hackathon allows. */
export const MAX_CO_AUTHOR_LIMIT = 10

/** The most co-authors a post of this kind may name. `maxTeamSize` is that of the hackathon the post's squad is in, or null when it has none. */
export function coAuthorLimit(kind: PostKind, maxTeamSize: number | null | undefined): number {
  if (kind !== 'DEMO' || !maxTeamSize || maxTeamSize < 1) return DEFAULT_CO_AUTHOR_LIMIT
  return Math.min(Math.max(maxTeamSize, DEFAULT_CO_AUTHOR_LIMIT), MAX_CO_AUTHOR_LIMIT)
}
