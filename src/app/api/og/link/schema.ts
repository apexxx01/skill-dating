import { z } from 'zod'

// The request schemas of og/link, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const querySchema = z
  .object({
    kind: z.enum(['passport', 'post', 'squad', 'achievement']),
    id: z.string().trim().min(1).max(100),
    user: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
