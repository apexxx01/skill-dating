import { z } from 'zod'

// The request schemas of users/[id]/skills/[skillId], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const updateUserSkillSchema = z.object({
  level: z.number().min(1).max(5).optional(),
  yearsExperience: z.number().min(0).max(50).optional(),
})
