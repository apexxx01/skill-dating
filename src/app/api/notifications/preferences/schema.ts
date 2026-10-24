import { z } from 'zod'
import { NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notification-kinds'

// The request schemas of notifications/preferences, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Which kinds of notification the caller wants. Every kind is on until it is switched off. The kinds are in src/lib/notification-kinds.ts.
export const bodySchema = z
  .object({
    preferences: z
      .object(Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, z.boolean().optional()])) as Record<NotificationKind, z.ZodOptional<z.ZodBoolean>>)
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'Send at least one kind'),
  })
  .strict()
