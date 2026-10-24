import { z } from 'zod'

// The request schemas of hackathons/[id]/teams, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const registerTeamSchema = z.object({
  teamId: z.string().max(64),
  projectId: z.string().max(64).optional(),
})
