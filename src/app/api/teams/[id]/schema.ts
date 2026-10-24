import { z } from 'zod'

// The request schemas of teams/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  maxSize: z.number().min(2).max(10).optional(),
  lookingFor: z.array(z.string().max(50)).max(20).optional(),
  isRecruiting: z.boolean().optional(),
  // The hackathon tracks the squad goes for (by name, as the hackathon has them); the squad builder's template follows them.
  targetTracks: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
})
