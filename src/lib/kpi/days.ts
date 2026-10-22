import { Prisma } from '@prisma/client'
import { addDaysToDateKey, isoWeekKeyOfDateKey, mondayOfDateKey } from '@/lib/time'
import { utcTimestamp } from '@/lib/sql'

// Days for the metrics. Every metric is measured for one UTC day D: the day runs from 00:00 UTC to the next 00:00 UTC, and a window "the last 7 days" is the 7 days that END with D.
// Dates are "YYYY-MM-DD" strings (the same form the rest of the platform uses for a calendar day); instants are made only where a query needs one.

export const DAY_MS = 24 * 60 * 60 * 1000

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/

export function isDay(value: string): boolean {
  if (!DAY_FORMAT.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseDay(value: string): Date {
  if (!isDay(value)) throw new Error(`not a YYYY-MM-DD day: ${value}`)
  return new Date(`${value}T00:00:00Z`)
}

export const formatDay = (date: Date): string => date.toISOString().slice(0, 10)

/** The UTC day before the one `now` is in: the latest day that is over. */
export const yesterday = (now: Date): string => formatDay(new Date(now.getTime() - DAY_MS))

export const addDays = addDaysToDateKey

/** The days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day)
  return days
}

export const weekKeyOf = isoWeekKeyOfDateKey
export const mondayOf = mondayOfDateKey

/** A day as the SQL `date` it is compared with. */
export const dateParam = (day: string): Prisma.Sql => Prisma.sql`${day}::date`

/** The instant the day starts, as a value to compare with a `timestamp` column holding UTC. */
export const startOf = (day: string): Prisma.Sql => utcTimestamp(parseDay(day))

/** The instant the day after it starts: the exclusive end of the day. */
export const endOf = (day: string): Prisma.Sql => utcTimestamp(parseDay(addDays(day, 1)))

/** The window of `length` days that ends with `day`: its first day. */
export const windowStart = (day: string, length: number): string => addDays(day, -(length - 1))
