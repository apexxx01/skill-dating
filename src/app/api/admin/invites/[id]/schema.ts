import { z } from 'zod'

// The request schemas of admin/invites/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/admin/invites/{id}: change a campaign code's label, limit or expiry, or switch it off (`disabled: true`) or on again. A personal code can only be switched off or on.
export const patchSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    maxUses: z.number().int().min(1).max(1_000_000).nullable(),
    expiresAt: z.string().datetime().nullable(),
    disabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')
