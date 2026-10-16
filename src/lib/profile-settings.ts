import { z } from 'zod'
import { isValidTimeZone } from '@/lib/time'
import { normalizeCountryCode, normalizePlace, placeKey } from '@/lib/places'
import { parseBirthDate } from '@/lib/matching/dating'

// The profile fields that decide where a person appears and what others can see:
// their time zone (which days, quests and caps follow), where they are (for the
// country, city and campus leaderboards) and two privacy switches. One schema and
// one mapping from the request to the rows, shared by the route and its tests.

export const profileSettingsSchema = z
  .object({
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine(isValidTimeZone, 'Not an IANA time zone such as "Asia/Kolkata"')
      .nullable(),
    countryCode: z
      .string()
      .trim()
      .refine((value) => normalizeCountryCode(value) !== null, 'Not an ISO 3166-1 alpha-2 country code such as "IN"')
      .nullable(),
    city: z.string().max(200).nullable(),
    campus: z.string().max(200).nullable(),
    hideFromLeaderboards: z.boolean(),
    showActivity: z.boolean(),
    // PRIVATE: shown to nobody but the owner, here. Only used to check that someone is 18 or older for dating. Set once, then locked
    // (a minor must not be able to change it to an adult's); it cannot be cleared.
    birthDate: z.string().refine((value) => parseBirthDate(value) !== null, 'A real date in the past such as 1995-06-15'),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export type ProfileSettingsInput = z.infer<typeof profileSettingsSchema>

export interface ProfileSettings {
  timezone: string | null
  countryCode: string | null
  city: string | null
  campus: string | null
  hideFromLeaderboards: boolean
  showActivity: boolean
  /** "YYYY-MM-DD", or null until it is set. Never part of anybody else's view of this person. */
  birthDate: string | null
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  timezone: null,
  countryCode: null,
  city: null,
  campus: null,
  hideFromLeaderboards: false,
  showActivity: true,
  birthDate: null,
}

/** The columns of Profile that follow from the request: tidied text and its comparable key together. */
export function profileColumns(input: ProfileSettingsInput) {
  const data: {
    countryCode?: string | null
    city?: string | null
    cityKey?: string | null
    campus?: string | null
    campusKey?: string | null
    hideFromLeaderboards?: boolean
    showActivity?: boolean
  } = {}
  if (input.countryCode !== undefined) data.countryCode = normalizeCountryCode(input.countryCode)
  if (input.city !== undefined) {
    data.city = normalizePlace(input.city)
    data.cityKey = placeKey(input.city)
  }
  if (input.campus !== undefined) {
    data.campus = normalizePlace(input.campus)
    data.campusKey = placeKey(input.campus)
  }
  if (input.hideFromLeaderboards !== undefined) data.hideFromLeaderboards = input.hideFromLeaderboards
  if (input.showActivity !== undefined) data.showActivity = input.showActivity
  return data
}
