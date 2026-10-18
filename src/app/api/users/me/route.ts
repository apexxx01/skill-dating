import { withAuth, createApiResponse } from '@/lib/api/handler'
import { ageStatusOf } from '@/lib/birth-date'
import { env } from '@/lib/env'
import { isOnboardingComplete } from '@/lib/onboarding'

// The caller's own local profile summary. Clerk's user id is not the local id, so
// anything that needs "who am I locally" (middleware's onboarding check, the
// onboarding page) asks here instead of reading the session.
//
// The date of birth is never part of it: `birthDateRequired` says whether onboarding still needs one, `isMinor` whether the account is a minor's
// (16 or 17, which limits what it can do: docs/SAFETY.md) and `ageRefused` whether it was refused for being under the minimum age.
export const GET = withAuth(async (_request, { prisma, user }) => {
  const [row, skillCount, age] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { headline: true, verificationLevel: true },
    }),
    prisma.userSkill.count({ where: { userId: user.id } }),
    ageStatusOf(prisma, user.id),
  ])

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
    birthDateRequired: env.BIRTH_DATE_REQUIRED && !age.hasBirthDate,
    isMinor: age.isMinor,
    ageRefused: age.refused,
    onboardingComplete: isOnboardingComplete({ headline: row?.headline, skillCount, hasBirthDate: age.hasBirthDate }, env.BIRTH_DATE_REQUIRED),
  })
})
