import { TIERS, type Tier } from '@/lib/levels'
import { sharedIntentReason } from './intents'
import { workingStyleSimilarity, WORKING_STYLE_QUIZ } from './quiz'
import { activeIntentTags, counterpartType, type IntentTag, type MatchType, type WorkingStyleAnswers } from './types'

// Compatibility v2: how well two people fit for one kind of relationship, as a number from 0 to 100, the pieces it is made of, and
// the (at most three) human-readable reasons behind it. Pure: it reads two profiles that the caller has already loaded and the
// clock it is given, and nothing else, so it is exhaustively unit-tested and can be run over thousands of candidates in a batch.
//
// The score is a weighted sum of components, each worth 0 to 1. All the weights are in SCORE_CONFIG below:
//   - a component with no data on one side (nobody said how many hours they have) counts as `neutral`, so a sparse profile is neither
//     rewarded nor punished more than the config says, and its reason is never shown;
//   - a component that does not apply (location, unless someone asked to meet in a city) is left out and the rest are scaled up to 100;
//   - the type of relationship scales some weights (a mentor is not chosen for the skills they share with their mentee) before that.
//
// The score is from the viewer's point of view: `viewer` is the person looking at `candidate` for a relationship of `connectionType`
// from the viewer's side (a MENTEE looks at candidates for a MENTOR).

export const COMPONENTS = [
  'skillComplement',
  'skillOverlap',
  'sharedStack',
  'intentMatch',
  'commitmentFit',
  'timezoneOverlap',
  'location',
  'workingStyle',
  'proofStrength',
  'activityRecency',
  'priorSignal',
] as const
export type ComponentKey = (typeof COMPONENTS)[number]

export const SCORE_CONFIG = {
  /** Points each component is worth when it applies; they add up to 100. */
  weights: {
    skillComplement: 22,
    skillOverlap: 8,
    sharedStack: 7,
    intentMatch: 14,
    commitmentFit: 9,
    timezoneOverlap: 9,
    location: 5,
    workingStyle: 8,
    proofStrength: 9,
    activityRecency: 5,
    priorSignal: 4,
  } satisfies Record<ComponentKey, number>,
  /**
   * What a type of relationship does to the weights, as multipliers (default 1). The weights are scaled back to 100 afterwards, so
   * these say what matters MORE OR LESS for that type. The types are from the viewer's side: a MENTEE chooses a mentor for what they have
   * shown, not for what they share, while a MENTOR looks at a mentee for drive (recent activity, the time they can give) more than for
   * proof. (The romance mode is scored by scoreRomance() below, with its own components: it never uses these.)
   */
  typeMultipliers: {
    MENTEE: { skillOverlap: 0.25, sharedStack: 0.5, commitmentFit: 0.6, proofStrength: 1.8, skillComplement: 1.2 },
    MENTOR: { skillOverlap: 0.25, sharedStack: 0.5, proofStrength: 0.7, activityRecency: 2, intentMatch: 1.3, skillComplement: 1.2 },
  } satisfies Partial<Record<MatchType, Partial<Record<ComponentKey, number>>>>,
  /** The value of a component the data cannot say anything about. */
  neutral: 0.4,
  /** Both people's day, as the hours of it that count for working together. */
  timezoneWindow: { startHour: 9, endHour: 19 },
  /** This many overlapping hours is a full score. */
  fullOverlapHours: 6,
  /** An overlap shorter than this is not worth saying. */
  minOverlapHoursToMention: 3,
  /** Hours per week: the larger of two is how many times the smaller can be before the fit is 0 (the ratio itself is the fit). */
  availabilityFullDays: 14,
  availabilityZeroDays: 90,
  /** Shared tech this many deep is a full score. */
  fullSharedStack: 3,
  /** Someone passed within this many days is not shown again. */
  passedCooldownDays: 30,
  /** Activity: how many days since last seen / last earning make a person fully stale. */
  staleAfterDays: 30,
  /** Streak (days) that counts as fully committed. */
  fullStreakDays: 14,
  /** How many reasons are returned, and how strong a reason must be (0 to 1) to be returned. */
  maxReasons: 3,
  minReasonStrength: 0.3,
} as const

// --- Inputs -----------------------------------------------------------------------------------------------

export interface ScoringSkill {
  slug: string
  name: string
  /** 1 to 5. */
  level: number
  /** Verified pieces of evidence for this skill. */
  evidence: number
}

/** Everything the score reads about one person, loaded by the caller. */
export interface ScoringProfile {
  userId: string
  connectionTypes: readonly MatchType[]
  intentTags: readonly IntentTag[]
  hoursPerWeek: number | null
  availableFrom: Date | null
  remoteOk: boolean
  cityOnly: boolean
  /** Skill slugs. */
  lookingForSkills: readonly string[]
  workingStyle: WorkingStyleAnswers
  skills: readonly ScoringSkill[]
  /** Technologies of their current build and projects, any case. */
  techStack: readonly string[]
  /** Minutes east of UTC, null when the time zone is not known. */
  utcOffsetMinutes: number | null
  /** The comparable key of their city (Profile.cityKey) and its display text. */
  cityKey: string | null
  city: string | null
  proof: { verifiedEvidence: number; tier: Tier; shipped: number; endorsements: number }
  activity: { streak: number; lastActiveAt: Date | null; lastXpAt: Date | null }
}

/** What happened between these two before. Blocked and recently passed people are never scored; a Build Date rating moves the score. */
export interface PriorSignal {
  blocked?: boolean
  passedAt?: Date | null
  /** The average rating (1 to 5) the viewer gave this person for past Build Dates, if there are any. */
  buildDateRating?: number | null
}

export interface ScoreInput {
  viewer: ScoringProfile
  candidate: ScoringProfile
  /** The relationship, from the viewer's side. */
  connectionType: MatchType
  now: Date
  prior?: PriorSignal
}

export interface ScoreComponent {
  /** 0 to 1. The neutral value when `known` is false. */
  value: number
  /** Points this component is worth for this score (0 when it does not apply). */
  weight: number
  /** value times weight. */
  points: number
  applicable: boolean
  /** False when there was nothing to compare. */
  known: boolean
}

export interface CompatibilityScore {
  /** A whole number, 0 to 100. */
  score: number
  components: Record<ComponentKey, ScoreComponent>
  /** At most three lines, strongest first. */
  reasons: string[]
  /** Set (with a score of 0) for a person who must not be shown at all. */
  excluded?: 'BLOCKED' | 'PASSED_RECENTLY'
}

// --- Helpers ----------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const plural = (count: number, one: string, many: string = `${one}s`) => `${count} ${count === 1 ? one : many}`
const sentenceList = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
const tierIndex = (tier: Tier) => Math.max(0, TIERS.indexOf(tier))
const normalizeTech = (name: string) => name.trim().toLowerCase()

interface Reason {
  text: string
  /** 0 to 1: how much this line is worth saying. */
  strength: number
}

interface Evaluated {
  /** Null when the data cannot say. */
  value: number | null
  reason?: Reason
  /** False to leave the component out of the score. */
  applicable?: boolean
}

/**
 * Hours of the day, 9 to 19 by default, that two people in different time zones are both in. Offsets are minutes east of UTC;
 * a half-hour zone gives a half-hour overlap. Symmetric.
 */
export function timezoneOverlapHours(offsetA: number, offsetB: number, startHour: number = SCORE_CONFIG.timezoneWindow.startHour, endHour: number = SCORE_CONFIG.timezoneWindow.endHour): number {
  const a0 = startHour * 60 - offsetA
  const a1 = endHour * 60 - offsetA
  const b0 = startHour * 60 - offsetB
  const b1 = endHour * 60 - offsetB
  let minutes = 0
  for (const shift of [-1440, 0, 1440]) minutes += Math.max(0, Math.min(a1, b1 + shift) - Math.max(a0, b0 + shift))
  return minutes / 60
}

const formatHours = (hours: number) => (Number.isInteger(hours) ? String(hours) : hours.toFixed(1))

/** How far a skill list covers what someone is looking for: each wanted skill the other has counts half, and the rest by their level. */
function coverage(wanted: readonly string[], have: readonly ScoringSkill[]): { value: number; best: ScoringSkill | null } {
  const bySlug = new Map(have.map((skill) => [skill.slug, skill]))
  let total = 0
  let best: ScoringSkill | null = null
  for (const slug of new Set(wanted)) {
    const skill = bySlug.get(slug)
    if (!skill) continue
    total += 0.5 + 0.5 * (clamp01(skill.level / 5))
    if (!best || skill.evidence > best.evidence || (skill.evidence === best.evidence && skill.level > best.level)) best = skill
  }
  const count = new Set(wanted).size
  return { value: count === 0 ? 0 : total / count, best }
}

// --- Components -------------------------------------------------------------------------------------------

function skillComplement({ viewer, candidate }: ScoreInput): Evaluated {
  const parts: number[] = []
  const reasons: Reason[] = []

  if (viewer.lookingForSkills.length > 0) {
    const mine = coverage(viewer.lookingForSkills, candidate.skills)
    parts.push(mine.value)
    if (mine.best) {
      const evidence = mine.best.evidence
      const text =
        evidence > 0
          ? `You need ${mine.best.name}, they have ${plural(evidence, `verified ${mine.best.name} project`)}`
          : `You need ${mine.best.name}, they have it at level ${mine.best.level}`
      reasons.push({ text, strength: clamp01(mine.value * (evidence > 0 ? 1 : 0.85)) })
    }
  }
  if (candidate.lookingForSkills.length > 0) {
    const theirs = coverage(candidate.lookingForSkills, viewer.skills)
    parts.push(theirs.value)
    if (theirs.best) reasons.push({ text: `They are looking for ${theirs.best.name}, which you have`, strength: clamp01(theirs.value * 0.8) })
  }
  if (parts.length === 0) return { value: null }
  const value = parts.reduce((sum, part) => sum + part, 0) / parts.length
  const reason = reasons.sort((a, b) => b.strength - a.strength)[0]
  return { value, reason }
}

function skillOverlap({ viewer, candidate }: ScoreInput): Evaluated {
  if (viewer.skills.length === 0 || candidate.skills.length === 0) return { value: null }
  const theirs = new Map(candidate.skills.map((skill) => [skill.slug, skill]))
  const shared = viewer.skills
    .flatMap((skill) => {
      const other = theirs.get(skill.slug)
      return other ? [{ name: skill.name, closeness: Math.min(skill.level, other.level) / 5 }] : []
    })
    .sort((a, b) => b.closeness - a.closeness || a.name.localeCompare(b.name))
  if (shared.length === 0) return { value: 0 }
  const value = clamp01(shared.reduce((sum, skill) => sum + skill.closeness, 0) / Math.min(viewer.skills.length, candidate.skills.length))
  const names = shared.slice(0, 2).map((skill) => skill.name)
  return { value, reason: { text: `You both know ${sentenceList(names)}`, strength: value } }
}

function sharedStack({ viewer, candidate }: ScoreInput): Evaluated {
  const mine = new Map(viewer.techStack.map((tech) => [normalizeTech(tech), tech.trim()]))
  const theirs = new Set(candidate.techStack.map(normalizeTech))
  mine.delete('')
  theirs.delete('')
  if (mine.size === 0 || theirs.size === 0) return { value: null }
  const shared = [...mine.entries()].filter(([key]) => theirs.has(key)).map(([, display]) => display).sort((a, b) => a.localeCompare(b))
  const value = clamp01(shared.length / SCORE_CONFIG.fullSharedStack)
  return { value, reason: shared.length > 0 ? { text: `You both build with ${sentenceList(shared.slice(0, 3))}`, strength: value } : undefined }
}

const intentKey = (tag: IntentTag) => `${tag.tag}|${tag.hackathonId ?? ''}`

function intentMatch({ viewer, candidate, now }: ScoreInput): Evaluated {
  const mine = activeIntentTags(viewer.intentTags, now)
  const theirs = activeIntentTags(candidate.intentTags, now)
  if (mine.length === 0 || theirs.length === 0) return { value: null }
  const theirKeys = new Set(theirs.map(intentKey))
  const shared = mine.filter((tag) => theirKeys.has(intentKey(tag)))
  if (shared.length === 0) return { value: 0 }
  const value = clamp01(shared.length / Math.min(mine.length, theirs.length))
  // A shared hackathon is the most concrete thing two people can have in common.
  const hackathon = shared.find((tag) => tag.hackathonId)
  const first = [...shared].sort((a, b) => a.tag.localeCompare(b.tag))[0]
  return { value, reason: { text: hackathon ? 'Both are going for the same hackathon' : sharedIntentReason(first.tag), strength: hackathon ? Math.max(value, 0.9) : value } }
}

function commitmentFit({ viewer, candidate }: ScoreInput): Evaluated {
  const hours =
    viewer.hoursPerWeek && candidate.hoursPerWeek && viewer.hoursPerWeek > 0 && candidate.hoursPerWeek > 0
      ? Math.min(viewer.hoursPerWeek, candidate.hoursPerWeek) / Math.max(viewer.hoursPerWeek, candidate.hoursPerWeek)
      : null
  let availability: number | null = null
  if (viewer.availableFrom && candidate.availableFrom) {
    const gapDays = Math.abs(viewer.availableFrom.getTime() - candidate.availableFrom.getTime()) / DAY_MS
    const { availabilityFullDays: full, availabilityZeroDays: zero } = SCORE_CONFIG
    availability = gapDays <= full ? 1 : gapDays >= zero ? 0 : 1 - (gapDays - full) / (zero - full)
  }
  if (hours === null && availability === null) return { value: null }
  const value = hours !== null && availability !== null ? 0.8 * hours + 0.2 * availability : (hours ?? availability)!
  const reason: Reason | undefined =
    hours !== null && hours >= 0.75
      ? { text: viewer.hoursPerWeek === candidate.hoursPerWeek ? `You both have about ${viewer.hoursPerWeek}h a week` : `Similar time to give: ${viewer.hoursPerWeek}h and ${candidate.hoursPerWeek}h a week`, strength: value }
      : undefined
  return { value, reason }
}

function timezoneOverlap({ viewer, candidate }: ScoreInput): Evaluated {
  if (viewer.utcOffsetMinutes === null || candidate.utcOffsetMinutes === null) return { value: null }
  const hours = timezoneOverlapHours(viewer.utcOffsetMinutes, candidate.utcOffsetMinutes)
  const value = clamp01(hours / SCORE_CONFIG.fullOverlapHours)
  return { value, reason: hours >= SCORE_CONFIG.minOverlapHoursToMention ? { text: `${formatHours(hours)}h timezone overlap`, strength: value } : undefined }
}

function location({ viewer, candidate }: ScoreInput): Evaluated {
  // Only when somebody asked to meet in a city; otherwise where people are does not matter to the score.
  if (!viewer.cityOnly && !candidate.cityOnly) return { value: null, applicable: false }
  const same = viewer.cityKey !== null && candidate.cityKey !== null && viewer.cityKey === candidate.cityKey
  return { value: same ? 1 : 0, reason: same ? { text: `Both based in ${candidate.city ?? viewer.city ?? 'the same city'}`, strength: 1 } : undefined }
}

const STYLE_WORDS: Record<string, string> = {
  pace: 'pace',
  communication: 'way of communicating',
  planning: 'way of planning',
  decisions: 'way of deciding',
  rhythm: 'working hours',
  risk: 'appetite for risk',
}

function workingStyle({ viewer, candidate }: ScoreInput): Evaluated {
  const value = workingStyleSimilarity(viewer.workingStyle, candidate.workingStyle)
  if (value === null) return { value: null }
  const same = WORKING_STYLE_QUIZ.filter((question) => viewer.workingStyle[question.id] !== undefined && viewer.workingStyle[question.id] === candidate.workingStyle[question.id]).map(
    (question) => STYLE_WORDS[question.id] ?? question.id
  )
  return { value, reason: same.length >= 2 ? { text: `You work alike: the same ${sentenceList(same.slice(0, 3))}`, strength: value } : undefined }
}

function proofStrength({ candidate }: ScoreInput): Evaluated {
  const { verifiedEvidence, tier, shipped, endorsements } = candidate.proof
  const value = clamp01(0.45 * Math.min(1, verifiedEvidence / 5) + 0.3 * (tierIndex(tier) / (TIERS.length - 1)) + 0.15 * Math.min(1, shipped / 5) + 0.1 * Math.min(1, endorsements / 10))
  let reason: Reason | undefined
  // What is said is a fact in its own right, so how much it is worth saying follows the fact and not the blend.
  if (shipped >= 3) reason = { text: `They have shipped ${shipped} projects`, strength: Math.max(value, Math.min(1, shipped / 5)) }
  else if (verifiedEvidence >= 1) reason = { text: `They have ${plural(verifiedEvidence, 'verified proof')} of their work`, strength: Math.max(value, Math.min(1, verifiedEvidence / 3)) }
  return { value, reason }
}

function activityRecency({ candidate, now }: ScoreInput): Evaluated {
  const { streak, lastActiveAt, lastXpAt } = candidate.activity
  const fresh = (at: Date | null) => (at ? clamp01(1 - (now.getTime() - at.getTime()) / DAY_MS / SCORE_CONFIG.staleAfterDays) : 0)
  const value = clamp01(0.5 * fresh(lastActiveAt) + 0.3 * fresh(lastXpAt) + 0.2 * Math.min(1, streak / SCORE_CONFIG.fullStreakDays))
  const reason: Reason | undefined = streak >= 7 ? { text: `They are on a ${streak}-day streak`, strength: value } : undefined
  return { value, reason }
}

function priorSignal({ prior }: ScoreInput): Evaluated {
  const rating = prior?.buildDateRating
  if (rating === undefined || rating === null) return { value: null }
  const value = clamp01((rating - 1) / 4)
  return { value, reason: rating >= 4 ? { text: 'You rated a past Build Date with them highly', strength: value } : undefined }
}

const EVALUATORS: Record<ComponentKey, (input: ScoreInput) => Evaluated> = {
  skillComplement,
  skillOverlap,
  sharedStack,
  intentMatch,
  commitmentFit,
  timezoneOverlap,
  location,
  workingStyle,
  proofStrength,
  activityRecency,
  priorSignal,
}

// --- The score --------------------------------------------------------------------------------------------

/** The weights for a relationship type: the config's, scaled by the type's multipliers, and (for the components that apply) back to 100 in total. */
export function effectiveWeights(connectionType: MatchType, applicable: Record<ComponentKey, boolean>): Record<ComponentKey, number> {
  const multipliers = (SCORE_CONFIG.typeMultipliers as Partial<Record<MatchType, Partial<Record<ComponentKey, number>>>>)[connectionType] ?? {}
  const raw = Object.fromEntries(COMPONENTS.map((key) => [key, applicable[key] ? SCORE_CONFIG.weights[key] * (multipliers[key] ?? 1) : 0])) as Record<ComponentKey, number>
  const total = COMPONENTS.reduce((sum, key) => sum + raw[key], 0)
  return Object.fromEntries(COMPONENTS.map((key) => [key, total === 0 ? 0 : (raw[key] / total) * 100])) as Record<ComponentKey, number>
}

/** Whether the viewer must not be shown this person at all. */
export function exclusionOf(prior: PriorSignal | undefined, now: Date): CompatibilityScore['excluded'] | undefined {
  if (prior?.blocked) return 'BLOCKED'
  if (prior?.passedAt && now.getTime() - prior.passedAt.getTime() < SCORE_CONFIG.passedCooldownDays * DAY_MS) return 'PASSED_RECENTLY'
  return undefined
}

function emptyComponents(): Record<ComponentKey, ScoreComponent> {
  return Object.fromEntries(COMPONENTS.map((key) => [key, { value: 0, weight: 0, points: 0, applicable: false, known: false }])) as Record<ComponentKey, ScoreComponent>
}

/**
 * The compatibility of `candidate` for `viewer`. Deterministic: the same input always gives the same score and the same reasons.
 * A blocked or recently passed candidate scores 0 with `excluded` set, and nothing else is worked out.
 */
export function scoreCompatibility(input: ScoreInput): CompatibilityScore {
  const excluded = exclusionOf(input.prior, input.now)
  if (excluded) return { score: 0, components: emptyComponents(), reasons: [], excluded }

  const evaluated = Object.fromEntries(COMPONENTS.map((key) => [key, EVALUATORS[key](input)])) as Record<ComponentKey, Evaluated>
  const applicable = Object.fromEntries(COMPONENTS.map((key) => [key, evaluated[key].applicable !== false])) as Record<ComponentKey, boolean>
  const weights = effectiveWeights(input.connectionType, applicable)

  const components = emptyComponents()
  let total = 0
  for (const key of COMPONENTS) {
    const { value } = evaluated[key]
    const known = value !== null
    const used = known ? clamp01(value) : applicable[key] ? SCORE_CONFIG.neutral : 0
    const points = used * weights[key]
    components[key] = { value: used, weight: weights[key], points, applicable: applicable[key], known: known && applicable[key] }
    total += points
  }

  // The strongest lines first, weighted by what each component is worth for this type; a tie goes to the component listed first.
  const reasons = COMPONENTS.flatMap((key, order) => {
    const reason = applicable[key] ? evaluated[key].reason : undefined
    return reason && reason.strength >= SCORE_CONFIG.minReasonStrength ? [{ ...reason, rank: reason.strength * weights[key], order }] : []
  })
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .slice(0, SCORE_CONFIG.maxReasons)
    .map((reason) => reason.text)

  return { score: Math.min(100, Math.max(0, Math.round(total))), components, reasons }
}

/** The relationship the candidate would be in, from their side. */
export const candidateSide = counterpartType
