import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'
import { BOARD_PERIODS, BOARD_SCOPES } from '@/lib/leaderboard-boards'

// The request schemas of leaderboard, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const querySchema = z.object({
  period: z.enum(BOARD_PERIODS).default('all-time'),
  scope: z.enum(BOARD_SCOPES).default('global'),
  // "IN", "IN:bengaluru", a campus, or a team id: see LeaderboardResponse. Absent: the caller's own place.
  scopeId: z.string().trim().min(1).max(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorParam,
})
