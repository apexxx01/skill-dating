import { PrismaClient } from '@prisma/client'
import { INTEGRATION_DATABASE_URL } from './config'
import { deleteRegisteredUsers } from './clerk-api'
import legalVersions from '../../src/config/legal-versions.json'

// A direct Prisma client against the same disposable integration database
// the test server itself uses - for setup/teardown and assertions the HTTP
// API has no route for (e.g. promoting a user to ADMIN, or checking a raw
// row count to prove idempotency rather than trusting a response body).
export const testPrisma = new PrismaClient({
  datasources: {
    db: { url: INTEGRATION_DATABASE_URL },
  },
})

/** Makes an account one the platform trusts as a counterparty: a week old (and a day) with a verified email. */
export async function establishAccount(userId: string, over: { ageDays?: number; verified?: boolean } = {}) {
  await testPrisma.user.update({
    where: { id: userId },
    data: { createdAt: new Date(Date.now() - (over.ageDays ?? 8) * 24 * 60 * 60 * 1000), isEmailVerified: over.verified ?? true },
  })
}

/**
 * An IANA zone where it is daytime right now (between 09:00 and 17:00), so a test does not depend on when it runs: a project shipped between 02:00 and
 * 05:00 local time unlocks the secret Night Owl achievement (75 XP), which changes every exact XP total, and a run near local midnight crosses a day.
 * Test accounts have no zone of their own, which means UTC, so a suite run between 02:00 and 05:00 UTC failed every test that counts XP after a ship.
 */
export function daytimeZone(now: Date = new Date()): string {
  // Closest to UTC first, and on the same calendar date as UTC when there is a choice (some tests compare with today's UTC date).
  const offsets = Array.from({ length: 25 }, (_, i) => i - 12).sort((a, b) => Math.abs(a) - Math.abs(b) || b - a)
  const fits = offsets.filter((hours) => {
    const local = now.getUTCHours() + hours
    return ((local % 24) + 24) % 24 >= 9 && ((local % 24) + 24) % 24 < 17
  })
  const sameDay = fits.find((hours) => now.getUTCHours() + hours >= 0 && now.getUTCHours() + hours < 24)
  const hours = sameDay ?? fits[0] ?? 0
  // Etc/GMT zones have the sign reversed: Etc/GMT-5 is five hours ahead of UTC.
  return hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`
}

/** Gives the account a zone where it is daytime now (daytimeZone). */
export async function pinDaytime(userId: string): Promise<void> {
  await testPrisma.user.update({ where: { id: userId }, data: { timezone: daytimeZone() } })
}

/** Records the current terms and privacy notice as accepted, which onboarding needs while CONSENT_REQUIRED is on (src/lib/privacy/consent.ts). */
export async function acceptLegalTerms(userId: string) {
  await testPrisma.consentRecord.createMany({
    data: (['TERMS', 'PRIVACY'] as const).map((type) => ({ userId, type, version: legalVersions[type], source: 'onboarding' })),
  })
}

export async function promoteToAdmin(userId: string) {
  await testPrisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } })
}

// Removes the local rows and the Clerk users this file created (matched by email
// marker), so a run never accumulates users on the shared development instance.
export async function cleanupTestUsers(emailContains: string) {
  await testPrisma.user.deleteMany({ where: { email: { contains: emailContains } } })
  await deleteRegisteredUsers(emailContains)
}
