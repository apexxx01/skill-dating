import { clerkClient } from '@clerk/nextjs/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { requireRecentAuth } from '@/lib/api/recent-auth'
import { loadConsentStates, missingRequired } from '@/lib/privacy/consent'
import { tombstoneClerkUser } from '@/lib/user-sync'
import { log } from '@/lib/log'
import { ageStatusOf } from '@/lib/birth-date'
import { env } from '@/lib/env'
import { isOnboardingComplete } from '@/lib/onboarding'

// The caller's own local profile summary. Clerk's user id is not the local id, so
// anything that needs "who am I locally" (middleware's onboarding check, the
// onboarding page) asks here instead of reading the session.
//
// The date of birth is never part of it: `ageRequired` says whether onboarding still needs one, `isMinor` whether the account is a minor's
// (16 or 17, which limits what it can do: docs/SAFETY.md) and `ageRefused` whether it was refused for being under the minimum age.
export const GET = withAuth(async (_request, { prisma, user }) => {
  const [row, skillCount, age, consents] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { headline: true, verificationLevel: true },
    }),
    prisma.userSkill.count({ where: { userId: user.id } }),
    ageStatusOf(prisma, user.id),
    loadConsentStates(prisma, user.id),
  ])
  // The terms and privacy notice to accept (onboarding, or again after a new version): docs/PRIVACY.md, "Consent".
  const consentRequired = missingRequired(consents)

  return createApiResponse({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role,
    headline: row?.headline ?? null,
    verificationLevel: row?.verificationLevel ?? 'NONE',
    skillCount,
    ageRequired: env.BIRTH_DATE_REQUIRED && !age.hasBirthDate,
    isMinor: age.isMinor,
    ageRefused: age.refused,
    consentRequired,
    onboardingComplete:
      isOnboardingComplete({ headline: row?.headline, skillCount, hasBirthDate: age.hasBirthDate }, env.BIRTH_DATE_REQUIRED) && (!env.CONSENT_REQUIRED || consentRequired.length === 0),
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:me' } })

// DELETE /api/users/me: deletes the caller's account (the right to erasure). Needs a session signed in within the last 10 minutes (403 REAUTH_REQUIRED).
// The Clerk account is deleted, and the local account is anonymised with everything it held handled by the data inventory (docs/PRIVACY.md): private
// data deleted, posts and comments blanked, what others depend on kept under the anonymised account. Works for a suspended or banned account too.
export const DELETE = withAuth(async (_request, { prisma, user, session }) => {
  const reauth = await requireRecentAuth(session)
  if (reauth) return reauth
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { clerkId: true } })
  if (!row?.clerkId) return createApiError('USER_NOT_FOUND')
  try {
    await (await clerkClient()).users.deleteUser(row.clerkId)
  } catch (error) {
    // Already gone at Clerk is fine; anything else is retried by the person.
    if ((error as { status?: number }).status !== 404) {
      log.error('could not delete the Clerk account', { error, userId: user.id })
      return createApiError('SERVICE_UNAVAILABLE')
    }
  }
  // The webhook does the same when Clerk tells us; doing it here makes the deletion immediate.
  await tombstoneClerkUser(row.clerkId)
  return createApiResponse({ deleted: true })
}, { rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 5, keyPrefix: 'users:me:delete' } })
