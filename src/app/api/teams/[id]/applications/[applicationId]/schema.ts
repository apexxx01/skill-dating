import { z } from 'zod'

// The request schemas of teams/[id]/applications/[applicationId], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const reviewSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED', 'WITHDRAWN']),
})
