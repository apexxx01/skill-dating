import { SCORE_CONFIG } from '@/lib/matching/score'
import { normalizeLabel, roleGapMessage, roleKey, roleLabel, type RoleNeed, type RoleRef } from './roles'

// Squad strength: how ready a squad is for a hackathon, as a number from 0 to 100, the components it is made of, and the gaps that hold it back
// ("No designer", "No one on this squad has deployed before", "Only 2h timezone overlap"). Pure: the caller loads the members, the needs and the
// history, so it is exhaustively unit-tested and the squad builder and the solo-pool optimiser can evaluate thousands of candidate squads with it.
//
// Same rules as the pairwise score (src/lib/matching/score.ts): a weighted sum of components worth 0 to 1, a component the data cannot say anything
// about counts as `neutral`, and one that does not apply (skills, when nothing is required) is left out and the rest are scaled back up to 100.
// docs/SQUADS.md has the formula with a worked example.

export const STRENGTH_COMPONENTS = ['roleCoverage', 'skillCoverage', 'timezoneOverlap', 'commitmentFit', 'experienceMix', 'chemistry'] as const
export type StrengthComponentKey = (typeof STRENGTH_COMPONENTS)[number]

export const STRENGTH_CONFIG = {
  /** Points per component when it applies; they add up to 100. */
  weights: { roleCoverage: 25, skillCoverage: 20, timezoneOverlap: 15, commitmentFit: 15, experienceMix: 15, chemistry: 10 } satisfies Record<StrengthComponentKey, number>,
  neutral: SCORE_CONFIG.neutral,
  /** Everybody's working day, local time, as the pairwise score has it. */
  window: SCORE_CONFIG.timezoneWindow,
  /** Hours the WHOLE squad shares that make a full score (fewer than for a pair: every extra zone narrows it). */
  fullOverlapHours: 4,
  /** Fewer shared hours than this is a gap. */
  lowOverlapHours: 3,
  /** The fewest hours a week over the most, below which the squad's time is a gap. */
  hoursMismatchRatio: 0.35,
  /** A pair who said they would build together again, and a pair who were on a team before. */
  chemistry: { wouldBuildAgain: 1, teamedBefore: 0.6 },
}

/** Some roles cover others: a full-stack developer is a frontend or a backend developer when the squad needs one. */
const ALSO_COVERS: Partial<Record<string, string[]>> = { FULLSTACK: ['FRONTEND', 'BACKEND'] }

export interface StrengthMember {
  userId: string
  /** The role they play on the squad: declared, the slot they fill, or the one they are proposed for. */
  role: RoleRef | null
  /** Roles they could also play: the roles they prefer, and what their skills imply. */
  canPlay: readonly RoleRef[]
  /** Skill names or slugs. */
  skills: readonly string[]
  /** Minutes east of UTC, null when unknown. */
  utcOffsetMinutes: number | null
  hoursPerWeek: number | null
  /** Has shipped (deployed) something before. */
  shipped: boolean
  /** Their commitment pledge for this hackathon, or null when none is asked of them (the hackathon has started). */
  pledge: { confirmed: boolean; hours: number | null } | null
  /** 0 to 1 from peer reviews, null when there are too few to say (src/lib/squads/reliability.ts). Never shown as a number. */
  reliability: number | null
}

export interface StrengthNeeds {
  /** The role template the squad is measured against (src/lib/squads/roles.ts templateFor), with each role's skills. */
  roles: readonly RoleNeed[]
  /** Further skills the squad needs (its open slots', say), on top of the roles' own. */
  requiredSkills: readonly string[]
  /** Whether pledges are due (before the hackathon starts). */
  pledgesExpected: boolean
  /** The hackathon's minTeamSize. */
  minSize: number
}

/** What two people have done together before. */
export interface PairHistory {
  a: string
  b: string
  /** Either said they would build with the other again. */
  wouldBuildAgain: boolean
  /** Hackathon teams they were both on. */
  teamsTogether: number
}

export interface StrengthInput {
  members: readonly StrengthMember[]
  needs: StrengthNeeds
  history: readonly PairHistory[]
}

export type StrengthGapCode = 'TOO_SMALL' | 'MISSING_ROLE' | 'NO_DEPLOYER' | 'MISSING_SKILLS' | 'LOW_TIMEZONE_OVERLAP' | 'UNCONFIRMED_PLEDGES' | 'HOURS_MISMATCH'

export interface StrengthGap {
  code: StrengthGapCode
  message: string
}

export interface StrengthComponent {
  /** 0 to 1; the neutral value when `known` is false. */
  value: number
  weight: number
  points: number
  applicable: boolean
  known: boolean
}

export interface RoleCoverage {
  key: string
  label: string
  /** Who covers it, or null. */
  userId: string | null
}

export interface SquadStrength {
  /** A whole number, 0 to 100. */
  score: number
  components: Record<StrengthComponentKey, StrengthComponent>
  gaps: StrengthGap[]
  roles: RoleCoverage[]
  /** Hours of the working day the whole squad shares, null when fewer than two time zones are known. */
  overlapHours: number | null
}

// --- Helpers ----------------------------------------------------------------------------------------------------

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const formatHours = (hours: number) => (Number.isInteger(hours) ? String(hours) : hours.toFixed(1))

/**
 * Hours of the working day (9 to 19 local by default) that everybody shares, for people at these UTC offsets (minutes east). Worked out on the
 * clock in quarter hours, so it is right across midnight and for half-hour zones.
 */
export function commonOverlapHours(offsets: readonly number[], startHour: number = STRENGTH_CONFIG.window.startHour, endHour: number = STRENGTH_CONFIG.window.endHour): number {
  if (offsets.length === 0) return 0
  const STEP = 15
  let shared = 0
  for (let utcMinute = 0; utcMinute < 1440; utcMinute += STEP) {
    const all = offsets.every((offset) => {
      const local = (((utcMinute + offset) % 1440) + 1440) % 1440
      return local >= startHour * 60 && local < endHour * 60
    })
    if (all) shared += STEP
  }
  return shared / 60
}

function covers(member: StrengthMember, need: string): 'declared' | 'able' | null {
  const declared = member.role ? roleKey(member.role) : null
  if (declared === need || (declared && ALSO_COVERS[declared]?.includes(need))) return 'declared'
  for (const ref of member.canPlay) {
    const key = roleKey(ref)
    if (key === need || ALSO_COVERS[key]?.includes(need)) return 'able'
  }
  return null
}

/**
 * Which member covers which role of the template: a maximum matching (each member covers one role), preferring the role a member declared over
 * one they merely could play. Deterministic: needs are tried in template order and members in the order given.
 */
export function assignRoles(members: readonly StrengthMember[], needs: readonly RoleRef[]): RoleCoverage[] {
  const keys = needs.map(roleKey)
  const owner = new Map<number, number>() // need index -> member index
  const tryAssign = (memberIndex: number, seen: Set<number>, level: 'declared' | 'any'): boolean => {
    for (let needIndex = 0; needIndex < keys.length; needIndex++) {
      const how = covers(members[memberIndex], keys[needIndex])
      if (!how || (level === 'declared' && how !== 'declared') || seen.has(needIndex)) continue
      seen.add(needIndex)
      const current = owner.get(needIndex)
      if (current === undefined || tryAssign(current, seen, level)) {
        owner.set(needIndex, memberIndex)
        return true
      }
    }
    return false
  }
  // Declared roles first, so a designer who said so is the designer; then whatever else the rest can play.
  const placed = new Set<number>()
  for (let i = 0; i < members.length; i++) if (tryAssign(i, new Set(), 'declared')) placed.add(i)
  for (let i = 0; i < members.length; i++) if (!placed.has(i) && ![...owner.values()].includes(i)) tryAssign(i, new Set(), 'any')
  return needs.map((need, index) => ({ key: keys[index], label: roleLabel(need), userId: owner.has(index) ? members[owner.get(index)!].userId : null }))
}

// --- The score ---------------------------------------------------------------------------------------------------

interface Evaluated {
  value: number | null
  applicable?: boolean
  gaps?: StrengthGap[]
}

function roleCoverage(input: StrengthInput, roles: RoleCoverage[]): Evaluated {
  if (input.needs.roles.length === 0) return { value: null, applicable: false }
  const covered = roles.filter((role) => role.userId !== null).length
  const gaps = input.needs.roles.flatMap((need, index) => (roles[index].userId === null ? [{ code: 'MISSING_ROLE' as const, message: roleGapMessage(need) }] : []))
  return { value: covered / input.needs.roles.length, gaps }
}

function skillCoverage({ members, needs }: StrengthInput): Evaluated {
  const required = new Map<string, string>()
  for (const skill of [...needs.roles.flatMap((role) => role.requiredSkills), ...needs.requiredSkills]) {
    const key = normalizeLabel(skill)
    if (key && !required.has(key)) required.set(key, skill.trim())
  }
  if (required.size === 0) return { value: null, applicable: false }
  const have = new Set(members.flatMap((member) => member.skills.map(normalizeLabel)))
  const missing = [...required.entries()].filter(([key]) => !have.has(key)).map(([, name]) => name)
  const value = (required.size - missing.length) / required.size
  const gaps: StrengthGap[] = missing.length > 0 ? [{ code: 'MISSING_SKILLS', message: `No one knows ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}` }] : []
  return { value, gaps }
}

function timezoneOverlap({ members }: StrengthInput): { evaluated: Evaluated; hours: number | null } {
  const offsets = members.map((member) => member.utcOffsetMinutes).filter((offset): offset is number => offset !== null)
  if (offsets.length < 2) return { evaluated: { value: null, applicable: members.length >= 2 }, hours: null }
  const hours = commonOverlapHours(offsets)
  const gaps: StrengthGap[] =
    hours < STRENGTH_CONFIG.lowOverlapHours
      ? [{ code: 'LOW_TIMEZONE_OVERLAP', message: hours === 0 ? 'No shared working hours across your time zones' : `Only ${formatHours(hours)}h timezone overlap` }]
      : []
  return { evaluated: { value: clamp01(hours / STRENGTH_CONFIG.fullOverlapHours), gaps }, hours }
}

function commitmentFit({ members, needs }: StrengthInput): Evaluated {
  const parts: number[] = []
  const gaps: StrengthGap[] = []

  const hours = members.map((member) => member.pledge?.hours ?? member.hoursPerWeek).filter((value): value is number => typeof value === 'number' && value > 0)
  if (hours.length >= 2) {
    const ratio = Math.min(...hours) / Math.max(...hours)
    parts.push(ratio)
    if (ratio < STRENGTH_CONFIG.hoursMismatchRatio) gaps.push({ code: 'HOURS_MISMATCH', message: `Time to give ranges from ${Math.min(...hours)}h to ${Math.max(...hours)}h` })
  }

  if (needs.pledgesExpected && members.length > 0) {
    const unconfirmed = members.filter((member) => !member.pledge?.confirmed).length
    parts.push((members.length - unconfirmed) / members.length)
    if (unconfirmed > 0) gaps.push({ code: 'UNCONFIRMED_PLEDGES', message: `${plural(unconfirmed, 'member has', 'members have')} not confirmed their commitment pledge` })
  }

  // How reliable the members have been for their past squads. Only ever part of this number: never a gap, never shown on its own.
  const reliability = members.map((member) => member.reliability).filter((value): value is number => value !== null)
  if (reliability.length > 0) parts.push(reliability.reduce((sum, value) => sum + value, 0) / reliability.length)

  if (parts.length === 0) return { value: null, gaps }
  return { value: parts.reduce((sum, part) => sum + part, 0) / parts.length, gaps }
}

function experienceMix({ members }: StrengthInput): Evaluated {
  if (members.length === 0) return { value: null }
  const shipped = members.filter((member) => member.shipped).length
  if (shipped === 0) return { value: 0, gaps: [{ code: 'NO_DEPLOYER', message: 'No one on this squad has deployed before' }] }
  return { value: clamp01(0.75 + 0.25 * (shipped - 1)) }
}

function chemistry({ members, history }: StrengthInput): Evaluated {
  if (members.length < 2) return { value: null, applicable: false }
  const ids = new Set(members.map((member) => member.userId))
  let total = 0
  let known = false
  for (const pair of history) {
    if (!ids.has(pair.a) || !ids.has(pair.b) || pair.a === pair.b) continue
    const value = pair.wouldBuildAgain ? STRENGTH_CONFIG.chemistry.wouldBuildAgain : pair.teamsTogether > 0 ? STRENGTH_CONFIG.chemistry.teamedBefore : 0
    if (value > 0) known = true
    total += value
  }
  if (!known) return { value: null }
  // A squad held together by a chain of good pairs (n - 1 of them) is full chemistry; strangers are neutral, never a penalty.
  return { value: STRENGTH_CONFIG.neutral + (1 - STRENGTH_CONFIG.neutral) * clamp01(total / (members.length - 1)) }
}

const GAP_ORDER: StrengthGapCode[] = ['TOO_SMALL', 'MISSING_ROLE', 'NO_DEPLOYER', 'MISSING_SKILLS', 'LOW_TIMEZONE_OVERLAP', 'UNCONFIRMED_PLEDGES', 'HOURS_MISMATCH']

/** The strength of a squad. Deterministic: the same input always gives the same score, components and gaps. */
export function squadStrength(input: StrengthInput): SquadStrength {
  const roles = assignRoles(input.members, input.needs.roles)
  const timezone = timezoneOverlap(input)
  const evaluated: Record<StrengthComponentKey, Evaluated> = {
    roleCoverage: roleCoverage(input, roles),
    skillCoverage: skillCoverage(input),
    timezoneOverlap: timezone.evaluated,
    commitmentFit: commitmentFit(input),
    experienceMix: experienceMix(input),
    chemistry: chemistry(input),
  }

  const applicable = Object.fromEntries(STRENGTH_COMPONENTS.map((key) => [key, evaluated[key].applicable !== false])) as Record<StrengthComponentKey, boolean>
  const rawTotal = STRENGTH_COMPONENTS.reduce((sum, key) => sum + (applicable[key] ? STRENGTH_CONFIG.weights[key] : 0), 0)

  let total = 0
  const components = {} as Record<StrengthComponentKey, StrengthComponent>
  for (const key of STRENGTH_COMPONENTS) {
    const weight = applicable[key] && rawTotal > 0 ? (STRENGTH_CONFIG.weights[key] / rawTotal) * 100 : 0
    const known = applicable[key] && evaluated[key].value !== null
    const value = known ? clamp01(evaluated[key].value!) : applicable[key] ? STRENGTH_CONFIG.neutral : 0
    components[key] = { value, weight, points: value * weight, applicable: applicable[key], known }
    total += value * weight
  }

  const gaps = STRENGTH_COMPONENTS.flatMap((key) => (applicable[key] ? (evaluated[key].gaps ?? []) : []))
  if (input.members.length < input.needs.minSize) {
    const short = input.needs.minSize - input.members.length
    gaps.unshift({ code: 'TOO_SMALL', message: `Needs ${plural(short, 'more member')} to reach the minimum of ${input.needs.minSize}` })
  }
  gaps.sort((a, b) => GAP_ORDER.indexOf(a.code) - GAP_ORDER.indexOf(b.code))

  return { score: Math.min(100, Math.max(0, Math.round(total))), components, gaps, roles, overlapHours: timezone.hours }
}
