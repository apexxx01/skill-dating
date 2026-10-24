import { cursorParam } from '@/lib/api/pagination'
import { z } from 'zod'

// The request schemas of users/[id]/skills, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: cursorParam,
})

export const addUserSkillSchema = z.object({
  skillId: z.string().max(64),
  level: z.number().min(1).max(5).default(1),
  yearsExperience: z.number().min(0).max(50).optional(),
})

export const updateUserSkillSchema = z.object({
  level: z.number().min(1).max(5).optional(),
  yearsExperience: z.number().min(0).max(50).optional(),
})
