import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse } from '@/lib/api/handler'
import { KIND_SPECS, NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notification-kinds'
import { loadPreferences, savePreferences } from '@/lib/notifications'

// Which kinds of notification the caller wants. Every kind is on until it is switched off. The kinds are in src/lib/notification-kinds.ts.
const bodySchema = z
  .object({
    preferences: z
      .object(Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, z.boolean().optional()])) as Record<NotificationKind, z.ZodOptional<z.ZodBoolean>>)
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'Send at least one kind'),
  })
  .strict()

const view = (enabled: Record<NotificationKind, boolean>) => ({
  preferences: NOTIFICATION_KINDS.map((kind) => ({ kind, label: KIND_SPECS[kind].label, type: KIND_SPECS[kind].type, enabled: enabled[kind] })),
})

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(view(await loadPreferences(prisma, user.id)))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:prefs-get' } })

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const changes = Object.fromEntries(Object.entries(body.data.preferences).filter(([, value]) => value !== undefined)) as Partial<Record<NotificationKind, boolean>>
  return createApiResponse(view(await savePreferences(prisma, user.id, changes)))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'notifications:prefs-put' } })
