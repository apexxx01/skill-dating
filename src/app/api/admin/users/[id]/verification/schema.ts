import { z } from 'zod'

// The request schemas of admin/users/[id]/verification, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/admin/users/{id}/verification { organizationVerified?, portfolioVerified?, identityVerified?, reason }: grants or takes back a mark only an
// admin can give (the verified-organisation mark among them). The level follows. Needs a session signed in within the last 10 minutes. Audited. Admins only.
export const bodySchema = z
  .object({ organizationVerified: z.boolean(), portfolioVerified: z.boolean(), identityVerified: z.boolean() })
  .partial()
  .extend({ reason: z.string().trim().min(3).max(1000) })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'Change at least one mark')
