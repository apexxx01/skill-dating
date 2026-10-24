import { z } from 'zod'

// The request schemas of romance/sparks, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const bodySchema = z
  .object({
    toId: z.string().min(1).max(64),
    // Length and quality are judged by the opener rules (src/lib/matching/opener.ts) so that the refusal says why.
    opener: z.string().max(2000),
    dropId: z.string().min(1).max(64).optional(),
  })
  .strict()
