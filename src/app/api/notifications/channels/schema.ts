import { z } from 'zod'
import { switchableKinds } from '@/lib/notify/policy'

// The request schemas of notifications/channels, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// How notifications reach the caller outside the app (docs/NOTIFICATIONS.md): the email and push switches, quiet hours, the digests, and for every kind of
// notification whether it comes by email and by push. In-app notifications have their own switches (GET/PUT /api/notifications/preferences) and are always shown.
export const clock = z.string().max(5).regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time such as 22:00')

export const kindChoice = z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).strict()

export const bodySchema = z
  .object({
    settings: z
      .object({
        emailEnabled: z.boolean().optional(),
        pushEnabled: z.boolean().optional(),
        quietHours: z.object({ enabled: z.boolean().optional(), start: clock.optional(), end: clock.optional() }).strict().optional(),
        dailyDigest: z.boolean().optional(),
        weeklyDigest: z.boolean().optional(),
      })
      .strict()
      .optional(),
    kinds: z
      .object(Object.fromEntries(switchableKinds().map((kind) => [kind, kindChoice.optional()])) as Record<string, z.ZodOptional<typeof kindChoice>>)
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.settings !== undefined || value.kinds !== undefined, 'Send settings, kinds or both')
