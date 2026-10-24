import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of projects/[id]/updates, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// MILESTONE and SHIPPED updates are written by the system (milestone
// completion, shipping); clients can only post these two kinds.
export const createUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(10000),
  type: z.enum(['UPDATE', 'ANNOUNCEMENT']).default('UPDATE'),
})

export const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursorParam,
})
