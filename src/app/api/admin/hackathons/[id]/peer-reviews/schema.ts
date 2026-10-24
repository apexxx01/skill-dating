import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of admin/hackathons/[id]/peer-reviews, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/admin/hackathons/{id}/peer-reviews: every peer review of a hackathon with its private note, for admins (moderation), newest first.
export const querySchema = z.object({ cursor: cursorParam, limit: z.coerce.number().int().min(1).max(100).default(50) })
