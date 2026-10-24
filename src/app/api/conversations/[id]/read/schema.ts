import { z } from 'zod'

// The request schemas of conversations/[id]/read, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const readSchema = z.object({
  upToMessageId: z.string().min(1).max(64).optional(),
})
