import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'
import { slotInputSchema, squadRoleSchema } from '@/lib/squads/schemas'

// The request schemas of teams, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  projectId: z.string().max(64).optional(),
  hackathonId: z.string().max(64).optional(),
  maxSize: z.number().min(2).max(10).default(5),
  // The old free-text needs: turned into OTHER (or inferred) slots. `slots` is the structured form; both may be sent.
  lookingFor: z.array(z.string().max(50)).max(20).default([]),
  slots: z.array(slotInputSchema).max(9).default([]),
  // The role the creator plays on the team.
  squadRole: squadRoleSchema.optional(),
  roleLabel: z.string().trim().min(1).max(40).optional(),
  isRecruiting: z.boolean().default(true),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  isRecruiting: z.coerce.boolean().optional(),
  hackathonId: z.string().max(64).optional(),
  skills: z.string().max(200).optional(),
  // Teams with an open slot for this role.
  role: squadRoleSchema.optional(),
  cursor: cursorParam,
})
