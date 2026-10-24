import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of teams/[id]/applications, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: cursorParam,
})

export const applySchema = z.object({
  message: z.string().max(1000).optional(),
  // The open slot applied for; accepting fills it.
  slotId: z.string().min(1).max(64).optional(),
})
