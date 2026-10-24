import type { PrismaClient } from '@prisma/client'
import { isAdult } from '@/lib/age-policy'
import { romanceOpenFor } from './launch'
import type { ErrorCode } from '@/lib/api/errors'

// "Tell me when it opens" (POST/DELETE /api/romance/interest, docs/ROMANCE.md "Launch"): the demand signal for the romance mode, which ships closed. An adult asks to be told; their
// country and city (the profile's, as they are when they ask) are kept with the request so the admin metrics can say where people are waiting. Nothing else is stored and nothing is
// shown to anybody else. When the mode opens where they are, the opening note is written once (./announce.ts).
//
//   - Adults only, with a date of birth on file: a minor, and an account that has not said how old it is, are refused with the same codes as the mode itself.
//   - Idempotent: asking again changes nothing but refreshes the place (and, if they were told once and the mode closed again, asks to be told the next time).
//   - Where the mode is already open for the person there is nothing to wait for (409 ROMANCE_ALREADY_OPEN).

type Db = Pick<PrismaClient, 'user' | 'profile' | 'romanceInterest' | 'featureFlag'>

export interface InterestState {
  /** The caller has asked to be told. */
  interested: boolean
  /** The mode is open for the caller now. */
  open: boolean
  /** The caller may ask: an adult with a date of birth on file. */
  eligible: boolean
}

export type InterestResult = { ok: true; state: InterestState } | { ok: false; code: Extract<ErrorCode, 'DATING_BIRTH_DATE_REQUIRED' | 'DATING_UNDERAGE' | 'ROMANCE_ALREADY_OPEN'> }

export async function interestStateOf(db: Db, userId: string, now: Date = new Date()): Promise<InterestState> {
  const [user, row, open] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { birthDate: true } }),
    db.romanceInterest.findUnique({ where: { userId }, select: { id: true } }),
    romanceOpenFor(db, userId),
  ])
  return { interested: row !== null, open, eligible: isAdult(user?.birthDate, now) }
}

export async function recordInterest(db: Db, userId: string, now: Date = new Date()): Promise<InterestResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { birthDate: true } })
  if (!user?.birthDate) return { ok: false, code: 'DATING_BIRTH_DATE_REQUIRED' }
  if (!isAdult(user.birthDate, now)) return { ok: false, code: 'DATING_UNDERAGE' }
  if (await romanceOpenFor(db, userId)) return { ok: false, code: 'ROMANCE_ALREADY_OPEN' }

  const place = await db.profile.findUnique({ where: { userId }, select: { countryCode: true, cityKey: true, city: true } })
  const snapshot = { countryCode: place?.countryCode ?? null, cityKey: place?.cityKey ?? null, city: place?.city ?? null }
  await db.romanceInterest.upsert({ where: { userId }, create: { userId, ...snapshot }, update: { ...snapshot, notifiedAt: null } })
  return { ok: true, state: { interested: true, open: false, eligible: true } }
}

/** Idempotent: nothing to remove is fine. */
export async function removeInterest(db: Pick<PrismaClient, 'romanceInterest'>, userId: string): Promise<void> {
  await db.romanceInterest.deleteMany({ where: { userId } })
}
