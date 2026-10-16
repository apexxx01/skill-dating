import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { datingBlockers, formatBirthDate, type DatingBlocker, type DatingFacts } from './dating'
import { INTENT_TAG_PATTERN, MAX_INTENT_TAGS } from './intents'
import { readWorkingStyle, workingStyleSchema } from './quiz'
import { activeIntentTags, DATING_MIN_AGE, MATCH_TYPES, type IntentTag, type MatchType, type WorkingStyleAnswers } from './types'

// A person's matching profile: what they are looking for and how they like to work. The request schema, how a stored row is shown,
// the checks that need the database (do the skills and the hackathon exist?) and the dating gate.

type Db = Pick<PrismaClient, 'skill' | 'hackathon' | 'user' | 'matchingProfile'>

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const DAY_MS = 24 * 60 * 60 * 1000
/** An intent tag may last up to a year. */
export const MAX_INTENT_LIFETIME_DAYS = 366

function isCalendarDate(value: string): boolean {
  const match = DATE_ONLY.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const intentTagSchema = z
  .object({
    tag: z.string().regex(INTENT_TAG_PATTERN, 'Lower-case letters, digits and dashes, 2 to 40 characters'),
    hackathonId: z.string().min(1).max(64).optional(),
    expiresAt: z.string().datetime({ offset: true, message: 'An ISO 8601 date and time' }).optional(),
  })
  .strict()

/** PUT /api/matching/profile. The whole profile: what is left out takes its default. */
export const matchingProfileSchema = z
  .object({
    connectionTypes: z
      .array(z.enum(MATCH_TYPES))
      .min(1, 'Choose at least one')
      .max(MATCH_TYPES.length)
      .refine((types) => new Set(types).size === types.length, 'Each type once'),
    intentTags: z
      .array(intentTagSchema)
      .max(MAX_INTENT_TAGS)
      .refine((tags) => new Set(tags.map((tag) => `${tag.tag}|${tag.hackathonId ?? ''}`)).size === tags.length, 'Each tag once')
      .default([]),
    hoursPerWeek: z.number().int().min(1).max(100).nullable().default(null),
    availableFrom: z.string().refine(isCalendarDate, 'A date such as 2026-12-01').nullable().default(null),
    remoteOk: z.boolean().default(true),
    cityOnly: z.boolean().default(false),
    lookingForSkills: z
      .array(z.string().regex(SKILL_SLUG, 'A skill slug'))
      .max(20)
      .refine((slugs) => new Set(slugs).size === slugs.length, 'Each skill once')
      .default([]),
    workingStyle: workingStyleSchema.default({}),
    dropTimeLocal: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time such as 09:00')
      .default('09:00'),
    paused: z.boolean().default(false),
  })
  .strict()

export type MatchingProfileInput = z.infer<typeof matchingProfileSchema>

/** A matching profile as the API shows it. */
export interface MatchingProfileView {
  connectionTypes: MatchType[]
  intentTags: IntentTag[]
  hoursPerWeek: number | null
  availableFrom: string | null
  remoteOk: boolean
  cityOnly: boolean
  lookingForSkills: string[]
  workingStyle: WorkingStyleAnswers
  dropTimeLocal: string
  paused: boolean
}

export const DEFAULT_MATCHING_PROFILE: MatchingProfileView = {
  connectionTypes: [],
  intentTags: [],
  hoursPerWeek: null,
  availableFrom: null,
  remoteOk: true,
  cityOnly: false,
  lookingForSkills: [],
  workingStyle: {},
  dropTimeLocal: '09:00',
  paused: false,
}

/** What is stored in `intentTags`, tolerating anything that was ever written there. */
export function readIntentTags(value: unknown): IntentTag[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): IntentTag[] => {
    if (!entry || typeof entry !== 'object') return []
    const { tag, hackathonId, expiresAt } = entry as Record<string, unknown>
    if (typeof tag !== 'string' || !INTENT_TAG_PATTERN.test(tag)) return []
    return [{ tag, ...(typeof hackathonId === 'string' ? { hackathonId } : {}), ...(typeof expiresAt === 'string' ? { expiresAt } : {}) }]
  })
}

export interface StoredMatchingProfile {
  connectionTypes: MatchType[]
  intentTags: unknown
  hoursPerWeek: number | null
  availableFrom: Date | null
  remoteOk: boolean
  cityOnly: boolean
  lookingForSkills: string[]
  workingStyle: unknown
  dropTimeLocal: string
  paused: boolean
}

export function toView(row: StoredMatchingProfile | null): MatchingProfileView {
  if (!row) return { ...DEFAULT_MATCHING_PROFILE }
  return {
    connectionTypes: [...row.connectionTypes],
    intentTags: readIntentTags(row.intentTags),
    hoursPerWeek: row.hoursPerWeek,
    availableFrom: row.availableFrom ? formatBirthDate(row.availableFrom) : null,
    remoteOk: row.remoteOk,
    cityOnly: row.cityOnly,
    lookingForSkills: [...row.lookingForSkills],
    workingStyle: readWorkingStyle(row.workingStyle),
    dropTimeLocal: row.dropTimeLocal,
    paused: row.paused,
  }
}

/** The columns a request sets. */
export function profileData(input: MatchingProfileInput): Omit<Prisma.MatchingProfileUncheckedCreateInput, 'userId'> {
  return {
    connectionTypes: input.connectionTypes,
    intentTags: input.intentTags.map((tag) => ({ ...tag, ...(tag.expiresAt ? { expiresAt: new Date(tag.expiresAt).toISOString() } : {}) })) as unknown as Prisma.InputJsonValue,
    hoursPerWeek: input.hoursPerWeek,
    availableFrom: input.availableFrom ? new Date(`${input.availableFrom}T00:00:00Z`) : null,
    remoteOk: input.remoteOk,
    cityOnly: input.cityOnly,
    lookingForSkills: input.lookingForSkills,
    workingStyle: input.workingStyle as Prisma.InputJsonValue,
    dropTimeLocal: input.dropTimeLocal,
    paused: input.paused,
  }
}

/**
 * Field errors for what only the database can check: the skills exist, the hackathons exist, a tag expires in the future
 * and within a year. Null when all is well. Shaped like Zod's `flatten().fieldErrors`.
 */
export async function referenceProblems(db: Pick<PrismaClient, 'skill' | 'hackathon'>, input: MatchingProfileInput, now: Date = new Date()): Promise<Record<string, string[]> | null> {
  const problems: Record<string, string[]> = {}

  if (input.lookingForSkills.length > 0) {
    const known = new Set((await db.skill.findMany({ where: { slug: { in: input.lookingForSkills }, isActive: true }, select: { slug: true } })).map((skill) => skill.slug))
    const unknown = input.lookingForSkills.filter((slug) => !known.has(slug))
    if (unknown.length > 0) problems.lookingForSkills = unknown.map((slug) => `Unknown skill: ${slug}`)
  }

  const hackathonIds = [...new Set(input.intentTags.flatMap((tag) => (tag.hackathonId ? [tag.hackathonId] : [])))]
  if (hackathonIds.length > 0) {
    const known = new Set((await db.hackathon.findMany({ where: { id: { in: hackathonIds } }, select: { id: true } })).map((hackathon) => hackathon.id))
    const unknown = hackathonIds.filter((id) => !known.has(id))
    if (unknown.length > 0) problems.intentTags = [...(problems.intentTags ?? []), ...unknown.map((id) => `Unknown hackathon: ${id}`)]
  }

  for (const tag of input.intentTags) {
    if (!tag.expiresAt) continue
    const at = new Date(tag.expiresAt).getTime()
    if (at <= now.getTime()) problems.intentTags = [...(problems.intentTags ?? []), `${tag.tag} has already expired`]
    else if (at > now.getTime() + MAX_INTENT_LIFETIME_DAYS * DAY_MS) problems.intentTags = [...(problems.intentTags ?? []), `${tag.tag} expires more than a year from now`]
  }

  return Object.keys(problems).length > 0 ? problems : null
}

// --- The dating gate --------------------------------------------------------------------------------------------

export interface DatingStatus {
  eligible: boolean
  blockers: DatingBlocker[]
  minAge: number
}

export const datingFactsSelect = { birthDate: true, isEmailVerified: true, isPhoneVerified: true, githubConnected: true } as const

export function datingStatus(facts: DatingFacts | null, now: Date = new Date()): DatingStatus {
  const blockers = facts ? datingBlockers(facts, now) : (['BIRTH_DATE_MISSING', 'EMAIL_NOT_VERIFIED', 'NO_PHONE_OR_GITHUB'] as DatingBlocker[])
  return { eligible: blockers.length === 0, blockers, minAge: DATING_MIN_AGE }
}

/** The error to answer with for a person who may not use dating, or null. A missing date of birth is told first, then age, then verification. */
export function datingRefusal(blockers: readonly DatingBlocker[]): ErrorCode | null {
  if (blockers.includes('BIRTH_DATE_MISSING')) return 'DATING_BIRTH_DATE_REQUIRED'
  if (blockers.includes('UNDER_AGE')) return 'DATING_UNDERAGE'
  if (blockers.length > 0) return 'DATING_VERIFICATION_REQUIRED'
  return null
}

/** Loads what the gate needs and applies it. Null when the person may use dating. */
export async function checkDatingGate(db: Pick<PrismaClient, 'user'>, userId: string, now: Date = new Date()): Promise<{ code: ErrorCode; blockers: DatingBlocker[] } | null> {
  const facts = await db.user.findUnique({ where: { id: userId }, select: datingFactsSelect })
  const status = datingStatus(facts, now)
  const code = datingRefusal(status.blockers)
  return code ? { code, blockers: status.blockers } : null
}

export async function loadOwnMatchingProfile(db: Db, userId: string, now: Date = new Date()) {
  const [row, facts] = await Promise.all([db.matchingProfile.findUnique({ where: { userId } }), db.user.findUnique({ where: { id: userId }, select: datingFactsSelect })])
  return { exists: row !== null, profile: toView(row), dating: datingStatus(facts, now) }
}

/** Tags that still count, for showing a profile to somebody else. */
export const liveIntentTags = (tags: IntentTag[], now: Date) => activeIntentTags(tags, now)
