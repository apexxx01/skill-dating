import { withAuth, createApiResponse } from '@/lib/api/handler'

// The caller's own local profile summary. Clerk's user id is not the local id, so
// anything that needs "who am I locally" (middleware's onboarding check, the
// onboarding page) asks here instead of reading the session.
export const GET = withAuth(async (_request, { prisma, user }) => {
  const [row, skillCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { headline: true, verificationLevel: true },
    }),
    prisma.userSkill.count({ where: { userId: user.id } }),
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
    onboardingComplete: Boolean(row?.headline) && skillCount > 0,
  })
})
