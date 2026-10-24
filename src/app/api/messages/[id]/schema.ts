import { z } from 'zod'

// The request schemas of messages/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const editMessageSchema = z.object({
  content: z.string().min(1).max(10000),
})
