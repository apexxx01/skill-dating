import { z } from 'zod'

// The request schemas of admin/invites, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Campaign invite codes, made by admins for a launch waitlist or a partner college (docs/INVITES.md): attribution only, no XP. GET lists them with how they are doing.
export const createSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    // Left out: a random one. Given: 4 to 32 letters and digits ("IISC2026").
    code: z.string().trim().max(40).optional(),
    campusId: z.string().max(64).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()

export const listSchema = z.object({ kind: z.enum(['PERSONAL', 'CAMPAIGN']).default('CAMPAIGN'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(64).optional() })
