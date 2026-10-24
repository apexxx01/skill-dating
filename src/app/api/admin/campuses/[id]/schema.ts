import { z } from 'zod'

// The request schemas of admin/campuses/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/admin/campuses/{id}: rename, change the domains or the place, or close the campus to new members (`disabled: true`; the people it has keep their place).
// The slug never changes: it is the key of the campus leaderboard and of everyone's place on it.
export const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    emailDomains: z.array(z.string().trim().max(253)).min(1).max(20),
    city: z.string().max(100).nullable(),
    countryCode: z.string().max(2).nullable(),
    disabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')
