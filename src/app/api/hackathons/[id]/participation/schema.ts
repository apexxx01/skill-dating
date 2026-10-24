import { z } from 'zod'
import { squadRoleSchema } from '@/lib/squads/schemas'

// The request schemas of hackathons/[id]/participation, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/hackathons/{id}/participation: the caller's place in the hackathon's solo pool (docs/SQUADS.md): looking for a team (the squad builder
// and the board draw from these people), the roles they would like to play, and whether the automatic squads two days before the registration
// deadline may place them.
export const bodySchema = z
  .object({
    lookingForTeam: z.boolean(),
    preferredRoles: z.array(squadRoleSchema).max(4),
    openToAutoTeam: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')
