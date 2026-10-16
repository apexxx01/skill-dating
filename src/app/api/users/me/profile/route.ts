import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, type ApiContext } from '@/lib/api/handler'
import { DEFAULT_PROFILE_SETTINGS, profileColumns, profileSettingsSchema, type ProfileSettings } from '@/lib/profile-settings'

// The caller's own location and privacy settings. The Profile row is created by the
// first save; until then every setting has its default.

async function readSettings(prisma: ApiContext['prisma'], userId: string): Promise<ProfileSettings> {
  const [user, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    prisma.profile.findUnique({
      where: { userId },
      select: { countryCode: true, city: true, campus: true, hideFromLeaderboards: true, showActivity: true },
    }),
  ])
  return { ...DEFAULT_PROFILE_SETTINGS, ...(profile ?? {}), timezone: user?.timezone ?? null }
}

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await readSettings(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:profile-get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(profileSettingsSchema)(request)
  if (body instanceof Response) return body

  const columns = profileColumns(body.data)
  await prisma.$transaction(async (tx) => {
    if (body.data.timezone !== undefined) {
      await tx.user.update({ where: { id: user.id }, data: { timezone: body.data.timezone } })
    }
    if (Object.keys(columns).length > 0) {
      await tx.profile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...columns }, update: columns })
    }
  })

  return createApiResponse(await readSettings(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'users:profile-patch' } })
