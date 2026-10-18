import { romanceCopy } from './config'

// The line the system puts at the top of a new romance match's conversation: that it is a match, what the two share (the lines scoreRomance() already worked out, so nothing is
// said that the score did not find), and a first question about what they build and are obsessed with, never about looks. Pure. Never a pronoun, never a photo.

export function buildRomanceIcebreaker(reasons: readonly string[]): string {
  const shared = reasons.slice(0, 2).map((line) => `${line}.`)
  return [`${romanceCopy.matchTitle}.`, ...shared, 'A good first question: what are you most obsessed with building right now?'].join(' ')
}
