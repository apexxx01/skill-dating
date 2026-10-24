import type { Prisma, PrismaClient } from '@prisma/client'
import { ageBandOf, cardsAllowed, MIN_PLATFORM_AGE, isMinor, wasMinorAt, type AgeBand } from '@/lib/age-policy'

// Setting a date of birth, once, under the platform age policy (src/lib/age-policy.ts, docs/SAFETY.md). The one place that writes User.birthDate for a person
// (an admin correction is the other, in src/lib/birth-date-admin.ts). It decides:
//
//   - nothing on file yet and 18+          stored; an adult
//   - nothing on file yet and 16 or 17     stored; a MINOR: the city, campus and free-text place already on their profile are cleared (a country is all they may share)
//   - nothing on file yet and under 16     NOT stored: only the moment of the refusal is kept (User.birthDateRefusedAt), the account is closed to everything but
//                                          asking for a correction, and no other date works until an admin corrects it
//   - a date already on file               the same date is fine and changes nothing; a different one is locked (BIRTH_DATE_LOCKED), so it cannot be edited to pass for an adult
//
// Two requests racing cannot overwrite each other: the write only happens while the column is still empty.
//
// The cards: a person who was under 18 at any point (a minor now, or an account made before the 18th birthday) has the "show my cards on the web" switch stored OFF, so turning 18
// does not publish anything: they turn it on themselves when they want it (keepCardsOff). The same holds for an admin's correction of the date.

type Db = PrismaClient | Prisma.TransactionClient

export type SetBirthDateResult =
  | { kind: 'SET'; band: Exclude<AgeBand, 'UNDER_MINIMUM'> }
  | { kind: 'SAME' }
  | { kind: 'LOCKED' }
  | { kind: 'REFUSED' }

/** Whether this person may have share cards at all: an adult whose age is on file. Only the verdict leaves; the date does not. */
export async function cardsAvailable(db: Db, userId: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { birthDate: true } })
  return cardsAllowed(row?.birthDate, now)
}

/** Stores "show my cards on the web" as off. For anybody who was under 18 at any point: their 18th birthday must not publish a card nobody chose. */
export async function keepCardsOff(db: Db, userId: string): Promise<void> {
  await db.profile.upsert({ where: { userId }, create: { userId, showCardsOnWeb: false }, update: { showCardsOnWeb: false } })
}

/** Whether a date of birth makes this account one that has been under 18 (as a member now, or on the day it was made), and so starts with its cards off. */
export const startsWithCardsOff = (birthDate: Date, accountCreatedAt: Date, now: Date = new Date()): boolean => isMinor(birthDate, now) || wasMinorAt(birthDate, accountCreatedAt)

/** Clears what an account for a minor may not carry: anything finer than a country. */
export async function clearMinorLocation(db: Db, userId: string): Promise<void> {
  await db.profile.updateMany({ where: { userId }, data: { city: null, cityKey: null, campus: null, campusKey: null } })
  await db.user.update({ where: { id: userId }, data: { location: null } })
}

export async function setBirthDate(db: Db, userId: string, birthDate: Date, now: Date = new Date()): Promise<SetBirthDateResult> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { birthDate: true, birthDateRefusedAt: true, createdAt: true } })
  if (!row) return { kind: 'REFUSED' }
  if (row.birthDate) return row.birthDate.getTime() === birthDate.getTime() ? { kind: 'SAME' } : { kind: 'LOCKED' }
  // Refused once, refused until an admin has looked: another date is not another chance.
  if (row.birthDateRefusedAt) return { kind: 'REFUSED' }

  const band = ageBandOf(birthDate, now)
  if (band === 'UNDER_MINIMUM') {
    await db.user.updateMany({ where: { id: userId, birthDate: null }, data: { birthDateRefusedAt: now } })
    await db.auditEvent.create({ data: { userId, action: 'AGE_REFUSED', targetType: 'USER', targetId: userId, newValue: { minAge: MIN_PLATFORM_AGE } } })
    return { kind: 'REFUSED' }
  }

  const written = await db.user.updateMany({ where: { id: userId, birthDate: null }, data: { birthDate } })
  if (written.count === 0) {
    // Lost a race: whoever won decides, the same date is fine.
    const current = await db.user.findUnique({ where: { id: userId }, select: { birthDate: true } })
    return current?.birthDate && current.birthDate.getTime() === birthDate.getTime() ? { kind: 'SAME' } : { kind: 'LOCKED' }
  }
  if (band === 'MINOR') await clearMinorLocation(db, userId)
  if (startsWithCardsOff(birthDate, row.createdAt, now)) await keepCardsOff(db, userId)
  return { kind: 'SET', band }
}

/** What an account is, for its owner: never the date itself. */
export interface OwnAgeStatus {
  /** Whether a date of birth is on file. */
  hasBirthDate: boolean
  /** 16 or 17. */
  isMinor: boolean
  /** Whether the account has been refused for being under the minimum age. */
  refused: boolean
}

export async function ageStatusOf(db: Pick<PrismaClient, 'user'>, userId: string, now: Date = new Date()): Promise<OwnAgeStatus> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { birthDate: true, birthDateRefusedAt: true } })
  return { hasBirthDate: Boolean(row?.birthDate), isMinor: isMinor(row?.birthDate, now), refused: Boolean(row?.birthDateRefusedAt) }
}
