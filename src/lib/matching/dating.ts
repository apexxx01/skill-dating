import { Prisma } from '@prisma/client'
import { DATING_MIN_AGE } from './types'

// The gate for DATING. It is a hard rule, applied in three places that all use this file: saving a matching profile that
// asks for DATING, building a person's daily drops, and sending a spark of that type. Dating needs ALL of:
//
//  - a verified email, and either a verified phone or a connected GitHub account (a real, reachable person);
//  - a date of birth on file that makes the person 18 or older. No date of birth, no dating. A minor is refused outright.
//
// Age is counted on the UTC calendar date, so in the hours when a birthday has come in one time zone and not yet in another the
// person is treated as not yet 18. The date of birth itself is private (see User.birthDate) and never leaves the server.

export type DatingBlocker = 'BIRTH_DATE_MISSING' | 'UNDER_AGE' | 'EMAIL_NOT_VERIFIED' | 'NO_PHONE_OR_GITHUB'

export interface DatingFacts {
  birthDate: Date | null
  isEmailVerified: boolean
  isPhoneVerified: boolean
  githubConnected: boolean
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

/** Whole years between a date of birth and `on`, by the UTC calendar. A 29 February birthday is reached on 1 March in a common year. */
export function ageOn(birthDate: Date, on: Date): number {
  const years = on.getUTCFullYear() - birthDate.getUTCFullYear()
  const reached = on.getUTCMonth() > birthDate.getUTCMonth() || (on.getUTCMonth() === birthDate.getUTCMonth() && on.getUTCDate() >= birthDate.getUTCDate())
  return reached ? years : years - 1
}

/** Everything that stands between this person and dating, in the order to tell them. Empty means they may. */
export function datingBlockers(facts: DatingFacts, now: Date = new Date()): DatingBlocker[] {
  const blockers: DatingBlocker[] = []
  if (!facts.birthDate) blockers.push('BIRTH_DATE_MISSING')
  else if (ageOn(facts.birthDate, now) < DATING_MIN_AGE) blockers.push('UNDER_AGE')
  if (!facts.isEmailVerified) blockers.push('EMAIL_NOT_VERIFIED')
  if (!facts.isPhoneVerified && !facts.githubConnected) blockers.push('NO_PHONE_OR_GITHUB')
  return blockers
}

export const isDatingEligible = (facts: DatingFacts, now: Date = new Date()): boolean => datingBlockers(facts, now).length === 0

/**
 * The latest date of birth that makes someone 18 on `now` ("YYYY-MM-DD"), for a query: born on or before it means 18 or older.
 * Agrees with ageOn() for every date (a 29 February birthday is after the cutoff of 28 February in a common year).
 */
export function adultBirthDateCutoff(now: Date = new Date()): string {
  const year = now.getUTCFullYear() - DATING_MIN_AGE
  let month = now.getUTCMonth() + 1
  let day = now.getUTCDate()
  // 29 February has no counterpart 18 years earlier unless that year is a leap year too.
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  if (month === 2 && day === 29 && !leap(year)) day = 28
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/**
 * SQL for "this user row may be matched for DATING", on the table alias `u` ("User"), to AND into a query. It is the same rule as
 * datingBlockers(), in the form a database can use.
 */
export function datingEligibleSql(alias: string, now: Date = new Date()): Prisma.Sql {
  const a = Prisma.raw(`"${alias.replace(/[^A-Za-z0-9_]/g, '')}"`)
  return Prisma.sql`(${a}."isEmailVerified" AND (${a}."isPhoneVerified" OR ${a}."githubConnected") AND ${a}."birthDate" IS NOT NULL AND ${a}."birthDate" <= ${adultBirthDateCutoff(now)}::date)`
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
