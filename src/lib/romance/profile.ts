import { z } from 'zod'
import { ageOn } from '@/lib/age'
import { AMBITION_LEVELS, GENDERS, LIFE_DIRECTIONS, ROMANCE_CONFIG, SCOPES, WORKING_RHYTHMS, type Gender, type LifeDirection, type Scope, type WorkingRhythm } from './config'

// A person's romance profile: work first, filters underneath. The request schema, how a stored row is shown to its owner, and what is shown to
// somebody else. Three rules shape every view in this file:
//
//   - the PUBLIC half (what a match or a drop sees) is the answers, the ambition, the direction, the rhythm and the obsessions. Nothing else.
//   - the PRIVATE half (gender, who they are interested in, the age range, the scope, the inbox gate) is returned to its owner on their own profile read and to
//     NOBODY else, in any response, including their matches. The only effect it has on others is that someone it refuses is never shown.
//   - photos are stored but only an owner sees them; others get a blurred placeholder until a mutual reveal (reveal.ts).

const OBSESSION = /^[\p{L}\p{N}][\p{L}\p{N} +#.&'\-]*$/u

const prompt = z.string().trim().min(ROMANCE_CONFIG.prompts.minLength, `At least ${ROMANCE_CONFIG.prompts.minLength} characters`).max(ROMANCE_CONFIG.prompts.maxLength)

export const romanceProfileSchema = z
  .object({
    promptObsessed: prompt,
    promptBuild: prompt,
    promptWeekend: prompt,
    ambition: z.number().int().min(1).max(AMBITION_LEVELS.length),
    direction: z.enum(LIFE_DIRECTIONS),
    rhythm: z.enum(WORKING_RHYTHMS),
    obsessions: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .min(ROMANCE_CONFIG.obsessions.minLength)
          .max(ROMANCE_CONFIG.obsessions.maxLength)
          .regex(OBSESSION, 'Letters, digits and + # . & \' - only')
      )
      .max(ROMANCE_CONFIG.obsessions.max)
      .refine((items) => new Set(items).size === items.length, 'Each one once')
      .default([]),
    gender: z.enum(GENDERS),
    genderSelfDescribe: z.string().trim().min(2).max(ROMANCE_CONFIG.genderSelfDescribeMax).nullable().default(null),
    interestedIn: z
      .array(z.enum(GENDERS))
      .min(1, 'Choose at least one')
      .refine((items) => new Set(items).size === items.length, 'Each once'),
    ageMin: z.number().int().min(ROMANCE_CONFIG.minAge).max(ROMANCE_CONFIG.maxAge),
    ageMax: z.number().int().min(ROMANCE_CONFIG.minAge).max(ROMANCE_CONFIG.maxAge),
    scope: z.enum(SCOPES),
    minEndorsements: z.number().int().min(0).max(ROMANCE_CONFIG.maxInboxEndorsements).default(0),
    paused: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ageMax < value.ageMin) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ageMax'], message: 'The oldest age cannot be below the youngest' })
    if (value.gender === 'SELF_DESCRIBED' && !value.genderSelfDescribe) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['genderSelfDescribe'], message: 'Say how you describe yourself' })
    if (value.gender !== 'SELF_DESCRIBED' && value.genderSelfDescribe) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['genderSelfDescribe'], message: 'Only when you describe yourself in your own words' })
  })

export type RomanceProfileInput = z.infer<typeof romanceProfileSchema>

/** What is stored, as the library needs it (the Prisma row has more columns). */
export interface StoredRomanceProfile {
  id: string
  userId: string
  promptObsessed: string
  promptBuild: string
  promptWeekend: string
  ambition: number
  direction: string
  rhythm: string
  obsessions: string[]
  gender: Gender
  genderSelfDescribe: string | null
  interestedIn: Gender[]
  ageMin: number
  ageMax: number
  scope: Scope
  minEndorsements: number
  paused: boolean
  createdAt: Date
  updatedAt: Date
}

/** The half of a profile that other people may see (a drop, a match). No filter, no gender, no photo URL. */
export interface PublicRomanceProfile {
  promptObsessed: string
  promptBuild: string
  promptWeekend: string
  ambition: number
  ambitionLabel: string
  direction: LifeDirection
  rhythm: WorkingRhythm
  obsessions: string[]
}

/** The owner's view: the public half plus their private filters, which only they ever receive. */
export interface OwnRomanceProfile extends PublicRomanceProfile {
  private: {
    gender: Gender
    genderSelfDescribe: string | null
    interestedIn: Gender[]
    ageMin: number
    ageMax: number
    scope: Scope
    minEndorsements: number
  }
  paused: boolean
  createdAt: string
  updatedAt: string
}

const ambitionLabel = (level: number) => AMBITION_LEVELS.find((entry) => entry.value === level)?.label ?? AMBITION_LEVELS[0].label
const asDirection = (value: string): LifeDirection => ((LIFE_DIRECTIONS as readonly string[]).includes(value) ? (value as LifeDirection) : 'open')
const asRhythm = (value: string): WorkingRhythm => ((WORKING_RHYTHMS as readonly string[]).includes(value) ? (value as WorkingRhythm) : 'steady')

export function toPublicProfile(row: Pick<StoredRomanceProfile, 'promptObsessed' | 'promptBuild' | 'promptWeekend' | 'ambition' | 'direction' | 'rhythm' | 'obsessions'>): PublicRomanceProfile {
  return {
    promptObsessed: row.promptObsessed,
    promptBuild: row.promptBuild,
    promptWeekend: row.promptWeekend,
    ambition: row.ambition,
    ambitionLabel: ambitionLabel(row.ambition),
    direction: asDirection(row.direction),
    rhythm: asRhythm(row.rhythm),
    obsessions: [...row.obsessions],
  }
}

export function toOwnProfile(row: StoredRomanceProfile): OwnRomanceProfile {
  return {
    ...toPublicProfile(row),
    private: {
      gender: row.gender,
      genderSelfDescribe: row.genderSelfDescribe,
      interestedIn: [...row.interestedIn],
      ageMin: row.ageMin,
      ageMax: row.ageMax,
      scope: row.scope,
      minEndorsements: row.minEndorsements,
    },
    paused: row.paused,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** The columns a request sets. */
export function profileColumns(input: RomanceProfileInput) {
  return {
    promptObsessed: input.promptObsessed,
    promptBuild: input.promptBuild,
    promptWeekend: input.promptWeekend,
    ambition: input.ambition,
    direction: input.direction,
    rhythm: input.rhythm,
    obsessions: input.obsessions,
    gender: input.gender,
    genderSelfDescribe: input.gender === 'SELF_DESCRIBED' ? input.genderSelfDescribe : null,
    interestedIn: input.interestedIn,
    ageMin: input.ageMin,
    ageMax: input.ageMax,
    scope: input.scope,
    minEndorsements: input.minEndorsements,
    paused: input.paused,
  }
}

/** The person's whole years today, for the filter rules. */
export const ageOfBirthDate = (birthDate: Date, now: Date = new Date()) => ageOn(birthDate, now)

/**
 * Problems only the person's place on file can show: a scope of CITY or COUNTRY means nothing without a city or a country, and would silently show
 * them nobody. Shaped like Zod's `flatten().fieldErrors`; null when all is well.
 */
export function scopeProblems(input: Pick<RomanceProfileInput, 'scope'>, place: { cityKey: string | null; countryCode: string | null }): Record<string, string[]> | null {
  if (input.scope === 'CITY' && !place.cityKey) return { scope: ['Add your city in your profile settings to look only in your city'] }
  if (input.scope === 'COUNTRY' && !place.countryCode) return { scope: ['Add your country in your profile settings to look only in your country'] }
  return null
}
