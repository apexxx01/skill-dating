// Intent tags: short, lower-case, dash-separated labels for what a person wants right now ("ship-mvp-90-days"). Anyone can use
// any well-formed tag; the ones below are suggested by the client and have a hand-written line for "why you matched". Any other
// tag is still matched on, and shown as its words.

export const INTENT_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/
export const MAX_INTENT_TAGS = 10

export interface KnownIntent {
  tag: string
  /** What the client shows to pick it. */
  label: string
  /** The reason line when both people have it. */
  both: string
}

export const KNOWN_INTENTS: readonly KnownIntent[] = [
  { tag: 'ship-by-year-end', label: 'Ship something by year end', both: 'Both want to ship by year end' },
  { tag: 'ship-mvp-90-days', label: 'Ship an MVP in 90 days', both: 'Both want to ship an MVP in 90 days' },
  { tag: 'win-a-hackathon', label: 'Win a hackathon', both: 'Both are here to win a hackathon' },
  { tag: 'find-cofounder', label: 'Find a cofounder', both: 'Both are looking for a cofounder' },
  { tag: 'join-early-team', label: 'Join an early team', both: 'Both want to join an early-stage team' },
  { tag: 'start-company', label: 'Start a company', both: 'Both want to start a company' },
  { tag: 'open-source', label: 'Build in the open', both: 'Both want to build in the open' },
  { tag: 'learn-by-building', label: 'Learn by building', both: 'Both want to learn by building' },
  { tag: 'weekend-project', label: 'Weekend projects', both: 'Both like weekend projects' },
  { tag: 'raise-funding', label: 'Raise funding', both: 'Both are working toward funding' },
  { tag: 'get-first-users', label: 'Get first users', both: 'Both want their first users' },
  { tag: 'career-switch', label: 'Switch into building', both: 'Both are switching into building' },
]

const KNOWN = new Map(KNOWN_INTENTS.map((intent) => [intent.tag, intent]))

/** "ship-mvp" becomes "ship mvp". */
export const humanizeTag = (tag: string) => tag.replace(/-+/g, ' ').trim()

/** The line for a tag both people have. */
export function sharedIntentReason(tag: string): string {
  return KNOWN.get(tag)?.both ?? `Both are into ${humanizeTag(tag)}`
}
