import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of admin/flags, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorParam,
})
