import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of blocks, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const createBlockSchema = z.object({
  userId: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  cursor: cursorParam,
})
