import { ageOn, birthDateCutoffForAge, formatBirthDate } from './age'
import { addDaysToDateKey, daysBetweenDateKeys, localDateKey } from './time'

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

/**
 * Whether a share card (a public image anyone with the link can fetch) may ever be drawn for this person: only an adult whose age is on file. A minor, and anyone whose age is not
 * known, have no cards, whatever their settings say.
 */
export function cardsAllowed(birthDate: Date | null | undefined, now: Date = new Date()): boolean {
  return birthDate ? ageBandOf(birthDate, now) === 'ADULT' : false
}

/** Whether the person was under 18 on `at` (for an account, the day it was made). A date of birth that is not on file says nothing. */
export function wasMinorAt(birthDate: Date | null | undefined, at: Date): boolean {
  return birthDate ? ageOn(birthDate, at) < ADULT_AGE : false
}

/** The calendar date ("YYYY-MM-DD") of the 18th birthday. A 29 February birthday is reached on 1 March in a common year, as in ageOn(). */
export function adultBirthdayOf(birthDate: Date): string {
  const year = birthDate.getUTCFullYear() + ADULT_AGE
  const month = birthDate.getUTCMonth() + 1
  const day = birthDate.getUTCDate()
  const exists = new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return exists ? `${pad(year, 4)}-${pad(month)}-${pad(day)}` : `${pad(year, 4)}-03-01`
}

/** How long after the 18th birthday the one-time note about the cards is still sent (a job that was down on the day catches up). */
export const ADULT_NOTICE_GRACE_DAYS = 7

/**
 * Whether the note about the cards is due now: it is sent once, from the 18th birthday on the person's own calendar, and not before the birthday has also come on the
 * UTC calendar the age policy counts in (otherwise the note could say "you can turn it on" for a few hours when the switch still refuses), for `ADULT_NOTICE_GRACE_DAYS` days.
 */
export function adultNoticeDue(birthDate: Date, timeZone: string | null | undefined, now: Date): boolean {
  const birthday = adultBirthdayOf(birthDate)
  const local = localDateKey(now, timeZone)
  const utc = localDateKey(now, 'UTC')
  if (birthday > local || birthday > utc) return false
  return daysBetweenDateKeys(birthday, local) <= ADULT_NOTICE_GRACE_DAYS
}

/** The 18th birthdays that can be due on `now` somewhere on Earth (a zone is at most a day ahead of or behind UTC): the earliest and latest date of birth to look at, for a query. */
export function adultNoticeWindow(now: Date): { from: string; to: string } {
  const today = localDateKey(now, 'UTC')
  const shift = (days: number) => {
    const date = new Date(`${addDaysToDateKey(today, days)}T00:00:00Z`)
    // 29 February minus 18 years rolls over to 1 March, which only widens the window by a day.
    return formatBirthDate(new Date(Date.UTC(date.getUTCFullYear() - ADULT_AGE, date.getUTCMonth(), date.getUTCDate())))
  }
  return { from: shift(-(ADULT_NOTICE_GRACE_DAYS + 2)), to: shift(1) }
}

/** For SQL: born on or before this date means 18 or older. */
export const adultCutoff = (now: Date = new Date()) => birthDateCutoffForAge(ADULT_AGE, now)
/** For SQL: born on or before this date means 16 or older. */
export const platformCutoff = (now: Date = new Date()) => birthDateCutoffForAge(MIN_PLATFORM_AGE, now)

/** What the profile of a minor may hold about where they are: a country, nothing finer. */
export const MINOR_LOCATION_FIELDS = ['city', 'campus', 'location'] as const
