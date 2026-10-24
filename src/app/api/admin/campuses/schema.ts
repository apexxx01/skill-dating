import { z } from 'zod'

// The request schemas of admin/campuses, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Campuses, managed by admins (docs/INVITES.md). A campus has a slug (the key its leaderboard is called by), a name, the e-mail domains of the college, and where it is.
export const createSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().max(80).optional(),
    emailDomains: z.array(z.string().trim().max(253)).min(1).max(20),
    city: z.string().max(100).nullable().optional(),
    countryCode: z.string().max(2).nullable().optional(),
  })
  .strict()

export const listSchema = z.object({ q: z.string().max(100).optional(), includeDisabled: z.enum(['true', 'false']).default('true'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(64).optional() })
