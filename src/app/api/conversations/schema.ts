import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of conversations, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Only person-to-person and ad-hoc group conversations are created here.
// Team, project and hackathon conversations are created atomically with the
// resource itself; letting a client create one bound to an arbitrary
// teamId/projectId/hackathonId would let anyone squat (or crash on) the single
// conversation slot those resources have.
export const createConversationSchema = z.object({
  type: z.enum(['DIRECT', 'GROUP']).default('DIRECT'),
  name: z.string().max(100).optional(),
  participantIds: z.array(z.string().min(1).max(64)).min(1).max(50),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  type: z.enum(['DIRECT', 'GROUP', 'PROJECT', 'TEAM', 'HACKATHON']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  cursor: cursorParam,
})
