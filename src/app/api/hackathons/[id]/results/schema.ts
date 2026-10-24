import { z } from 'zod'

// The request schemas of hackathons/[id]/results, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const resultsSchema = z.object({
  results: z.array(z.object({
    hackathonTeamId: z.string().max(64).min(1),
    rank: z.number().min(1),
    score: z.number().optional(),
  })).min(1).max(500),
})
