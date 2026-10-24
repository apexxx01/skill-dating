import { z } from 'zod'

// The request schemas of teams/[id]/transfer-ownership, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const transferSchema = z.object({
  newOwnerId: z.string().max(64).min(1),
})
