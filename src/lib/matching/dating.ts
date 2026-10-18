import { Prisma } from '@prisma/client'
import { ageOn, birthDateCutoffForAge, formatBirthDate, parseBirthDate } from '@/lib/age'
import { DATING_MIN_AGE } from './types'

// The date arithmetic lives in src/lib/age.ts (shared with the platform age policy); re-exported here for the callers that always imported it from this file.
export { ageOn, formatBirthDate, parseBirthDate }

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

/** The latest date of birth that makes someone 18 on `now` ("YYYY-MM-DD"), for a query: born on or before it means 18 or older. */
export const adultBirthDateCutoff = (now: Date = new Date()): string => birthDateCutoffForAge(DATING_MIN_AGE, now)

/**
 * SQL for "this user row may be matched for DATING", on the table alias `u` ("User"), to AND into a query. It is the same rule as
 * datingBlockers(), in the form a database can use.
 */
export function datingEligibleSql(alias: string, now: Date = new Date()): Prisma.Sql {
  const a = Prisma.raw(`"${alias.replace(/[^A-Za-z0-9_]/g, '')}"`)
  return Prisma.sql`(${a}."isEmailVerified" AND (${a}."isPhoneVerified" OR ${a}."githubConnected") AND ${a}."birthDate" IS NOT NULL AND ${a}."birthDate" <= ${adultBirthDateCutoff(now)}::date)`
}
