import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of teams/applications, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Self-scoped view of the caller's own outstanding/resolved team
// applications. Every other query against TeamApplication is scoped by
// teamId and gated to the team owner/admin (see [id]/applications and
// [id]/candidates) — this is the only place an applicant can see what
// happened to their own applications. Always scoped to the session's
// user.id; a userId is never accepted from the client.
export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']).optional(),
  cursor: cursorParam,
})
