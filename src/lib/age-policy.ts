import { ageOn, birthDateCutoffForAge } from './age'

// The platform age policy (docs/SAFETY.md). NEEDS LEGAL REVIEW FOR EACH LAUNCH COUNTRY (GDPR-K, COPPA, India DPDP Act 2023): the numbers
// below are the product's starting position, not legal advice.
//
//   under 16   refused at onboarding (AGE_BELOW_MINIMUM); nothing about the person is stored except that they were refused
//   16 and 17  a MINOR: may use the platform's professional features, but never the romance mode, never visible to recruiters (when there
//              are any), a location no finer than their country, and excluded from every 18+ surface
//   18 and up  an ADULT
//
// A person is a minor while their date of birth says so; there is no stored flag to go stale, so the restrictions end on the 18th birthday
// without a job. Everything that is age-dependent asks this file.

export const MIN_PLATFORM_AGE = 16
export const ADULT_AGE = 18

export type AgeBand = 'UNDER_MINIMUM' | 'MINOR' | 'ADULT'

export function ageBandOf(birthDate: Date, now: Date = new Date()): AgeBand {
  const age = ageOn(birthDate, now)
  if (age < MIN_PLATFORM_AGE) return 'UNDER_MINIMUM'
  return age < ADULT_AGE ? 'MINOR' : 'ADULT'
}

/** 16 or 17. A person with no date of birth on file is not known to be a minor (they cannot reach any 18+ surface either: those need a date). */
export function isMinor(birthDate: Date | null | undefined, now: Date = new Date()): boolean {
  return birthDate ? ageBandOf(birthDate, now) === 'MINOR' : false
}

/**
 * Whether a recruiter may ever see this person. There are no recruiters yet; this is the one question a future recruiter surface must ask. A minor is
 * never visible, and neither is anyone whose age is not on file (we cannot tell they are an adult).
 */
export function recruiterVisible(birthDate: Date | null | undefined, now: Date = new Date()): boolean {
  return birthDate ? ageBandOf(birthDate, now) === 'ADULT' : false
}

/** For SQL: born on or before this date means 18 or older. */
export const adultCutoff = (now: Date = new Date()) => birthDateCutoffForAge(ADULT_AGE, now)
/** For SQL: born on or before this date means 16 or older. */
export const platformCutoff = (now: Date = new Date()) => birthDateCutoffForAge(MIN_PLATFORM_AGE, now)

/** What the profile of a minor may hold about where they are: a country, nothing finer. */
export const MINOR_LOCATION_FIELDS = ['city', 'campus', 'location'] as const
