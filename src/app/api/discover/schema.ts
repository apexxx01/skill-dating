import { cursorParam } from '@/lib/api/pagination'
import { z } from 'zod'

// The request schemas of discover, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  skills: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  cursor: cursorParam,
})
