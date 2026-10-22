import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { Campus, Prisma, PrismaClient } from '@prisma/client'
import { isMinor } from '@/lib/age-policy'
import { isDisposableEmail } from '@/lib/identity/signup'
import { getEmail, type EmailSender } from '@/lib/infra/email'
import { track } from '@/lib/infra/analytics'
import { renderCodeEmail } from '@/lib/notify/templates'
import { DEFAULT_LOCALE } from '@/lib/notify/strings'
import { signingSecret } from '@/lib/notify/tokens'
import { normalizeCountryCode, normalizePlace, placeKey } from '@/lib/places'

// Campuses and how a person joins one (docs/INVITES.md, "Campuses"). A campus is a record an admin makes: a name, a slug, the e-mail domains of the college. A person is on
// its leaderboard and in its feed (Profile.campusKey = the slug) only after proving they can read mail at one of those domains: a six-digit code, mailed to the address,
// good for 15 minutes and 5 tries.
//
// The address is PRIVATE. It is kept (CampusVerification.email) only until the code is confirmed or has expired, then erased. What stays is CampusMembership.emailHash, a keyed
// hash that stops one mailbox from verifying two accounts and cannot be turned back into the address. Nothing here ever returns an address, to its owner or anyone else.
// A minor (or an account whose age is not known) shares a country and nothing finer, so it cannot join a campus.

type Db = PrismaClient | Prisma.TransactionClient

export const CODE_LENGTH = 6
export const CODE_TTL_MINUTES = 15
export const MAX_CODE_ATTEMPTS = 5

const MINUTE_MS = 60_000

// --- Pure -----------------------------------------------------------------------------------------------------------------

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** A domain as it is stored: lower case, no leading "@" or "www", no trailing dot. Null if it is not a domain. */
export function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')
  return domain.length <= 253 && DOMAIN.test(domain) ? domain : null
}

export function normalizeDomains(inputs: readonly string[]): string[] | null {
  const out = new Set<string>()
  for (const input of inputs) {
    const domain = normalizeDomain(input)
    if (!domain) return null
    out.add(domain)
  }
  return [...out]
}

/** The address in the form it is compared: trimmed, lower case. Null if it is not an address. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1 || email.length > 254 || /\s/.test(email) || email.indexOf('@') !== at) return null
  return normalizeDomain(email.slice(at + 1)) ? email : null
}

/** Whether an address is on one of the domains, or a subdomain of one (`cs.iisc.ac.in` is on `iisc.ac.in`; `evil-iisc.ac.in` is not). */
export function emailOnDomains(email: string, domains: readonly string[]): boolean {
  const normalized = normalizeEmail(email)
  if (!normalized) return false
  const host = normalized.slice(normalized.lastIndexOf('@') + 1)
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** A slug for a campus name: the same key places use everywhere, so it is what a leaderboard scope id is parsed to. */
export function campusSlug(name: string): string | null {
  const slug = placeKey(name)
  return slug && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80 ? slug : null
}

// Hashes are keyed with the server's signing secret, so a copy of the database alone cannot be used to guess addresses or codes.
const mac = (purpose: string, value: string) => createHmac('sha256', signingSecret()).update(`${purpose}:${value}`).digest('hex')

export const emailHashOf = (normalizedEmail: string) => mac('campus-email', normalizedEmail)
export const codeHashOf = (userId: string, code: string) => mac('campus-code', `${userId}:${code}`)

export function newCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// --- Verifying -----------------------------------------------------------------------------------------------------------

export interface PlaceBefore {
  hidden: boolean
  countryCode: string | null
  cityKey: string | null
  campusKey: string | null
}

export type StartOutcome =
  | { ok: true; expiresAt: Date; domain: string }
  | { ok: false; code: 'CAMPUS_NOT_FOUND' | 'CAMPUS_CLOSED' | 'MINOR_LOCATION_LIMITED' | 'CAMPUS_EMAIL_INVALID' | 'CAMPUS_EMAIL_IN_USE'; domains?: string[] }

export interface StartOptions {
  email?: EmailSender
  now?: Date
}

/** Mails a code to a campus address, if the person may join the campus and the address is theirs to use. */
export async function startVerification(db: PrismaClient, userId: string, input: { campusId: string; email: string }, options: StartOptions = {}): Promise<StartOutcome> {
  const now = options.now ?? new Date()
  const [campus, user] = await Promise.all([
    db.campus.findUnique({ where: { id: input.campusId } }),
    db.user.findUnique({ where: { id: userId }, select: { birthDate: true, deletedAt: true } }),
  ])
  if (!campus) return { ok: false, code: 'CAMPUS_NOT_FOUND' }
  if (campus.disabledAt) return { ok: false, code: 'CAMPUS_CLOSED' }
  // A minor, and an account that has not said how old it is yet, may share a country and nothing finer.
  if (!user || user.deletedAt || user.birthDate === null || isMinor(user.birthDate, now)) return { ok: false, code: 'MINOR_LOCATION_LIMITED' }

  const email = normalizeEmail(input.email)
  if (!email || isDisposableEmail(email) || !emailOnDomains(email, campus.emailDomains)) return { ok: false, code: 'CAMPUS_EMAIL_INVALID', domains: campus.emailDomains }
  const emailHash = emailHashOf(email)
  const taken = await db.campusMembership.findUnique({ where: { emailHash }, select: { userId: true } })
  if (taken && taken.userId !== userId) return { ok: false, code: 'CAMPUS_EMAIL_IN_USE' }

  const code = newCode()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * MINUTE_MS)
  await db.campusVerification.upsert({
    where: { userId },
    create: { userId, campusId: campus.id, email, emailHash, codeHash: codeHashOf(userId, code), expiresAt },
    update: { campusId: campus.id, email, emailHash, codeHash: codeHashOf(userId, code), attempts: 0, expiresAt, createdAt: now },
  })
  const rendered = renderCodeEmail({ locale: DEFAULT_LOCALE, code, minutes: CODE_TTL_MINUTES })
  // A transactional message: no unsubscribe link, the person just asked for it.
  await (options.email ?? getEmail()).send({ to: email, subject: rendered.subject, html: rendered.html, text: rendered.text, tags: { kind: 'campus-code' } })
  return { ok: true, expiresAt, domain: email.slice(email.lastIndexOf('@') + 1) }
}

export type ConfirmOutcome =
  | { ok: true; campus: Pick<Campus, 'id' | 'slug' | 'name'>; previous: PlaceBefore }
  | { ok: false; code: 'CAMPUS_VERIFICATION_NOT_FOUND' | 'CAMPUS_CODE_EXPIRED' | 'CAMPUS_CODE_INVALID' | 'CAMPUS_EMAIL_IN_USE'; remaining?: number }

async function placeOf(db: Db, userId: string): Promise<PlaceBefore> {
  const profile = await db.profile.findUnique({ where: { userId }, select: { hideFromLeaderboards: true, countryCode: true, cityKey: true, campusKey: true } })
  return { hidden: profile?.hideFromLeaderboards ?? false, countryCode: profile?.countryCode ?? null, cityKey: profile?.cityKey ?? null, campusKey: profile?.campusKey ?? null }
}

/** Checks a code; on a match the person becomes a member of the campus: the key leaderboards and the feed read is set, and the address is erased. */
export async function confirmVerification(db: PrismaClient, userId: string, code: string, now: Date = new Date()): Promise<ConfirmOutcome> {
  const pending = await db.campusVerification.findUnique({ where: { userId } })
  if (!pending) return { ok: false, code: 'CAMPUS_VERIFICATION_NOT_FOUND' }
  if (pending.expiresAt.getTime() <= now.getTime() || pending.attempts >= MAX_CODE_ATTEMPTS) {
    await db.campusVerification.delete({ where: { userId } })
    return { ok: false, code: 'CAMPUS_CODE_EXPIRED' }
  }
  if (!sameHash(pending.codeHash, codeHashOf(userId, code.trim()))) {
    const updated = await db.campusVerification.update({ where: { userId }, data: { attempts: { increment: 1 } }, select: { attempts: true } })
    if (updated.attempts >= MAX_CODE_ATTEMPTS) {
      await db.campusVerification.delete({ where: { userId } })
      return { ok: false, code: 'CAMPUS_CODE_EXPIRED' }
    }
    return { ok: false, code: 'CAMPUS_CODE_INVALID', remaining: MAX_CODE_ATTEMPTS - updated.attempts }
  }

  const campus = await db.campus.findUnique({ where: { id: pending.campusId }, select: { id: true, slug: true, name: true, countryCode: true, disabledAt: true } })
  if (!campus || campus.disabledAt) {
    await db.campusVerification.delete({ where: { userId } })
    return { ok: false, code: 'CAMPUS_VERIFICATION_NOT_FOUND' }
  }
  const previous = await placeOf(db, userId)
  try {
    await db.$transaction(async (tx) => {
      // The same mailbox on two accounts: the unique hash settles a race between them.
      await tx.campusMembership.upsert({ where: { userId }, create: { userId, campusId: campus.id, emailHash: pending.emailHash, verifiedAt: now }, update: { campusId: campus.id, emailHash: pending.emailHash, verifiedAt: now } })
      // The campus stands for a place too: a person who has not said which country they are in is in the campus's.
      const profile = await tx.profile.findUnique({ where: { userId }, select: { countryCode: true } })
      const columns = { campus: campus.name, campusKey: campus.slug, ...(profile?.countryCode || !campus.countryCode ? {} : { countryCode: campus.countryCode }) }
      await tx.profile.upsert({ where: { userId }, create: { userId, ...columns }, update: columns })
      await tx.campusVerification.delete({ where: { userId } })
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      await db.campusVerification.deleteMany({ where: { userId } })
      return { ok: false, code: 'CAMPUS_EMAIL_IN_USE' }
    }
    throw error
  }
  await track(userId, 'campus_verified', { campus: campus.slug })
  return { ok: true, campus: { id: campus.id, slug: campus.slug, name: campus.name }, previous }
}

/** Leaves the campus: the key is cleared (the person leaves its board and feed), and the hash of the address goes with the membership. Returns where they were. */
export async function leaveCampus(db: PrismaClient, userId: string): Promise<{ left: boolean; previous: PlaceBefore }> {
  const previous = await placeOf(db, userId)
  const membership = await db.campusMembership.findUnique({ where: { userId }, select: { userId: true } })
  await db.$transaction(async (tx) => {
    await tx.campusMembership.deleteMany({ where: { userId } })
    await tx.campusVerification.deleteMany({ where: { userId } })
    await tx.profile.updateMany({ where: { userId }, data: { campus: null, campusKey: null } })
  })
  return { left: membership !== null, previous }
}

/** Erases the addresses of verifications that expired or were left: the address lives only as long as its code does. */
export async function sweepVerifications(db: Pick<PrismaClient, 'campusVerification'>, now: Date = new Date()): Promise<number> {
  const removed = await db.campusVerification.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 60 * MINUTE_MS) } } })
  return removed.count
}

// --- Campuses (admin) ----------------------------------------------------------------------------------------------------

export interface CampusInput {
  name: string
  emailDomains: string[]
  city?: string | null
  countryCode?: string | null
  slug?: string
}

export function campusColumns(input: Partial<CampusInput>): { ok: true; data: Partial<Pick<Campus, 'name' | 'emailDomains' | 'city' | 'cityKey' | 'countryCode'>> } | { ok: false; field: string; message: string } {
  const data: Partial<Pick<Campus, 'name' | 'emailDomains' | 'city' | 'cityKey' | 'countryCode'>> = {}
  if (input.name !== undefined) {
    const name = normalizePlace(input.name)
    if (!name) return { ok: false, field: 'name', message: 'A name' }
    data.name = name
  }
  if (input.emailDomains !== undefined) {
    const domains = normalizeDomains(input.emailDomains)
    if (!domains || domains.length === 0) return { ok: false, field: 'emailDomains', message: 'One or more domains such as iisc.ac.in' }
    data.emailDomains = domains
  }
  if (input.city !== undefined) {
    data.city = input.city === null ? null : normalizePlace(input.city)
    data.cityKey = input.city === null ? null : placeKey(input.city)
  }
  if (input.countryCode !== undefined) {
    if (input.countryCode === null) data.countryCode = null
    else {
      const code = normalizeCountryCode(input.countryCode)
      if (!code) return { ok: false, field: 'countryCode', message: 'An ISO 3166-1 alpha-2 country code such as IN' }
      data.countryCode = code
    }
  }
  return { ok: true, data }
}
