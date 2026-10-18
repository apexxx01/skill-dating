// Dates of birth and ages, counted on the UTC calendar. Pure. The date itself is private (User.birthDate): it is read to work out an age band
// and is returned to nobody but its owner.

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/** Whole years between a date of birth and `on`, by the UTC calendar. A 29 February birthday is reached on 1 March in a common year. */
export function ageOn(birthDate: Date, on: Date): number {
  const years = on.getUTCFullYear() - birthDate.getUTCFullYear()
  const reached = on.getUTCMonth() > birthDate.getUTCMonth() || (on.getUTCMonth() === birthDate.getUTCMonth() && on.getUTCDate() >= birthDate.getUTCDate())
  return reached ? years : years - 1
}

/**
 * The latest date of birth that makes someone `age` on `now` ("YYYY-MM-DD"), for a query: born on or before it means `age` or older.
 * Agrees with ageOn() for every date (a 29 February birthday is after the cutoff of 28 February in a common year).
 */
export function birthDateCutoffForAge(age: number, now: Date = new Date()): string {
  const year = now.getUTCFullYear() - age
  const month = now.getUTCMonth() + 1
  let day = now.getUTCDate()
  // 29 February has no counterpart `age` years earlier unless that year is a leap year too.
  if (month === 2 && day === 29 && !isLeapYear(year)) day = 28
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** A date of birth as it is written in a request: a real calendar date, not in the future, not before 1900. */
export function parseBirthDate(value: string, now: Date = new Date()): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  if (year < 1900 || date.getTime() > now.getTime()) return null
  return date
}

/** "YYYY-MM-DD" of a stored date of birth. */
export const formatBirthDate = (date: Date): string => `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
