import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of admin/fraud-signals, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/admin/fraud-signals?status=&cursor=: groups the nightly collusion run flagged (src/lib/integrity), newest first. Staff only.
export const querySchema = z.object({
  status: z.enum(['OPEN', 'CONFIRMED', 'DISMISSED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursorParam,
})
