import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'
import { dueDateSchema } from '@/lib/milestones'

// The request schemas of projects/[id]/milestones, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const createMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  dueDate: dueDateSchema.optional(),
})

export const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursorParam,
})
