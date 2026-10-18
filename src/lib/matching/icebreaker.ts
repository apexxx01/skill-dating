import { sharedIntentReason } from './intents'
import type { ScoringProfile } from './score'
import { activeIntentTags, type MatchType } from './types'

// The line the system puts at the top of a new match's conversation, so nobody faces an empty box: what the two have in common, and a first
// question. Pure. For DATING it never mentions skills or work history, only what they said they want and how they like to work.

export interface SharedGround {
  /** Names of the skills both have, strongest shared level first. */
  skills: string[]
  /** Technologies both build with. */
  stack: string[]
  /** Intent tags both have (active at the time), a tag tied to a hackathon only for the same hackathon. */
  intents: string[]
  /** Whether one of the shared intents is for the same hackathon. */
  sameHackathon: boolean
}

const sentenceList = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

export function sharedGround(a: ScoringProfile, b: ScoringProfile, now: Date): SharedGround {
  const theirSkills = new Map(b.skills.map((skill) => [skill.slug, skill]))
  const skills = a.skills
    .flatMap((skill) => {
      const other = theirSkills.get(skill.slug)
      return other ? [{ name: skill.name, level: Math.min(skill.level, other.level) }] : []
    })
    .sort((x, y) => y.level - x.level || x.name.localeCompare(y.name))
    .map((skill) => skill.name)

  const mine = new Map(a.techStack.map((tech) => [tech.trim().toLowerCase(), tech.trim()]))
  const theirs = new Set(b.techStack.map((tech) => tech.trim().toLowerCase()))
  mine.delete('')
  const stack = [...mine.entries()].filter(([key]) => theirs.has(key)).map(([, display]) => display).sort((x, y) => x.localeCompare(y))

  const key = (tag: { tag: string; hackathonId?: string }) => `${tag.tag}|${tag.hackathonId ?? ''}`
  const theirIntents = new Set(activeIntentTags(b.intentTags, now).map(key))
  const shared = activeIntentTags(a.intentTags, now).filter((tag) => theirIntents.has(key(tag)))
  return {
    skills,
    stack,
    intents: [...new Set(shared.map((tag) => tag.tag))].sort(),
    sameHackathon: shared.some((tag) => tag.hackathonId !== undefined),
  }
}

const CLOSING: Record<MatchType, string> = {
  COFOUNDER: 'A good first question: what are you each building right now, and what would you want a cofounder to own?',
  HACKATHON_TEAMMATE: 'A good first question: which hackathon are you eyeing next, and what role do you want on the team?',
  COLLABORATOR: 'A good first question: what is each of you working on, and where could you use a second pair of hands?',
  MENTOR: 'A good first question for a mentor: what would you like to help someone get unstuck on?',
  MENTEE: 'A good first question for a mentee: what are you stuck on right now, and what would a good outcome look like?',
  DATING: 'Say hello, and ask what they are building or learning right now.',
}

const HEADLINE: Record<MatchType, string> = {
  COFOUNDER: 'It is a match: you both want a cofounder.',
  HACKATHON_TEAMMATE: 'It is a match: you both want a hackathon teammate.',
  COLLABORATOR: 'It is a match: you both want to collaborate.',
  MENTOR: 'It is a match: a mentor and a mentee.',
  MENTEE: 'It is a match: a mentor and a mentee.',
  DATING: 'It is a match.',
}

/** The icebreaker for a match of `type` (the relationship, from either side), from what the two have in common. */
export function buildIcebreaker(type: MatchType, ground: SharedGround): string {
  const lines: string[] = [HEADLINE[type]]
  if (ground.sameHackathon) lines.push('You are both going for the same hackathon.')
  const intents = ground.intents.filter((tag) => tag !== 'win-a-hackathon' || !ground.sameHackathon)
  if (intents.length > 0) lines.push(`${sharedIntentReason(intents[0])}.`)
  if (type !== 'DATING') {
    if (ground.skills.length > 0) lines.push(`You both know ${sentenceList(ground.skills.slice(0, 3))}.`)
    if (ground.stack.length > 0) lines.push(`You both build with ${sentenceList(ground.stack.slice(0, 3))}.`)
  }
  lines.push(CLOSING[type])
  return lines.join(' ')
}
