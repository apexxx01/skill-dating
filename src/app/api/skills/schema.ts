import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of skills, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const createSkillSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).optional(),
  category: z.string().min(1).max(50),
  subcategory: z.string().max(50).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
})

export const addUserSkillSchema = z.object({
  skillId: z.string().max(64),
  level: z.number().min(1).max(5).default(1),
  yearsExperience: z.number().min(0).max(50).optional(),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  category: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  cursor: cursorParam,
})
