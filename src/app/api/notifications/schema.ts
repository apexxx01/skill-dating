import { cursorParam } from '@/lib/api/pagination'
import { z } from 'zod'

// The request schemas of notifications, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  unreadOnly: z.coerce.boolean().default(false),
  type: z.string().max(200).optional(),
  cursor: cursorParam,
})

// Bulk mark-as-read on the collection route. Path-segment tricks like
// PATCH /api/notifications/read-all don't reach this file at all (no such
// route exists), so "mark all" is a body flag instead; a single notification
// is marked read via PATCH /api/notifications/[id].
export const markAllSchema = z.object({ all: z.literal(true) })
