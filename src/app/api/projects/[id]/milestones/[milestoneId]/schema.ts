import { z } from 'zod'
import { dueDateSchema } from '@/lib/milestones'

// The request schemas of projects/[id]/milestones/[milestoneId], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const patchMilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    order: z.number().int().min(0).max(10000).optional(),
    completed: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), { message: 'Nothing to update' })
