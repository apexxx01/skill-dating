import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse } from '@/lib/api/handler'
import { KIND_SPECS, NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notification-kinds'
import { loadPreferences, savePreferences } from '@/lib/notifications'
import { isRomanceKind, romanceOpenFor } from '@/lib/romance/launch'
import { bodySchema } from './schema'

// The romance kinds are listed only where the mode is open (src/lib/romance/launch.ts); a closed mode appears in no list.
const view = (enabled: Record<NotificationKind, boolean>, romanceOpen: boolean) => ({
  preferences: NOTIFICATION_KINDS.filter((kind) => romanceOpen || !isRomanceKind(kind)).map((kind) => ({ kind, label: KIND_SPECS[kind].label, type: KIND_SPECS[kind].type, enabled: enabled[kind] })),
})

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(view(await loadPreferences(prisma, user.id), await romanceOpenFor(prisma, user.id)))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:prefs-get' } })

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const changes = Object.fromEntries(Object.entries(body.data.preferences).filter(([, value]) => value !== undefined)) as Partial<Record<NotificationKind, boolean>>
  return createApiResponse(view(await savePreferences(prisma, user.id, changes), await romanceOpenFor(prisma, user.id)))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'notifications:prefs-put' } })
