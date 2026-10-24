import { z } from 'zod'
import { SEARCH_LIMITS } from '@/lib/search'

// The request schemas of search, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/search?q=&types=users,projects,crews,hackathons,posts&limit=&cursor=: the command palette's search (docs/SEARCH.md). One ranked list over people,
// projects, crews, hackathons and posts, with typo and prefix matching, that never returns anything the caller may not see.
export const querySchema = z.object({
  q: z.string().max(SEARCH_LIMITS.maxQueryLength * 2).default(''),
  types: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMITS.maxLimit).default(SEARCH_LIMITS.defaultLimit),
  cursor: z.string().min(1).max(300).optional(),
})
