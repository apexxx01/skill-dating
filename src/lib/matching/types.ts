// The vocabulary of the matching engine, free of Prisma so the pure modules (score.ts, opener.ts, ...) can use it.

/** What a person can be looking for. MENTOR and MENTEE are the two sides of one relationship; every other type pairs with itself. */
export const MATCH_TYPES = ['COFOUNDER', 'HACKATHON_TEAMMATE', 'COLLABORATOR', 'MENTOR', 'MENTEE', 'DATING'] as const
export type MatchType = (typeof MATCH_TYPES)[number]

/** The type the other side has to have for the two to fit: a mentee looks for a mentor, a cofounder for a cofounder. */
export function counterpartType(type: MatchType): MatchType {
  if (type === 'MENTOR') return 'MENTEE'
  if (type === 'MENTEE') return 'MENTOR'
  return type
}

/** The name of the relationship itself, the same from both sides: what a Match is stored under. */
export function relationshipType(type: MatchType): MatchType {
  return type === 'MENTEE' ? 'MENTOR' : type
}

export const isMatchType = (value: unknown): value is MatchType => typeof value === 'string' && (MATCH_TYPES as readonly string[]).includes(value)

/** The types of `mine` that `theirs` can be paired with, in the order of `mine`. */
export function pairableTypes(mine: readonly MatchType[], theirs: readonly MatchType[]): MatchType[] {
  const other = new Set(theirs)
  return mine.filter((type) => other.has(counterpartType(type)))
}

/** Something a person wants right now: a short tag, optionally tied to one hackathon, optionally expiring. */
export interface IntentTag {
  tag: string
  hackathonId?: string
  /** ISO 8601 instant; the tag stops counting at this moment. */
  expiresAt?: string
}

/** The tags that still count at `now`. */
export function activeIntentTags(tags: readonly IntentTag[], now: Date): IntentTag[] {
  return tags.filter((tag) => tag.expiresAt === undefined || new Date(tag.expiresAt).getTime() > now.getTime())
}

/** A person's answers to the working-style quiz: question id to option id. Questions may be left unanswered. */
export type WorkingStyleAnswers = Record<string, string>

/** Every type that is not DATING. A DATING pair never mixes with any of them, in either direction. */
export const NON_DATING_TYPES: readonly MatchType[] = MATCH_TYPES.filter((type) => type !== 'DATING')

export const DATING_MIN_AGE = 18
