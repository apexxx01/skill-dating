import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of squad-proposals, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/squad-proposals: the squads proposed to the caller (the solo pool's) and the ones they asked the builder for, newest first.
export const querySchema = z.object({ cursor: cursorParam, limit: z.coerce.number().int().min(1).max(50).default(20) })
