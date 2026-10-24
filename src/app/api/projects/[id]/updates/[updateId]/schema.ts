import { z } from 'zod'

// The request schemas of projects/[id]/updates/[updateId], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const editUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(10000).optional(),
  })
  .refine((v) => v.title !== undefined || v.content !== undefined, { message: 'Nothing to update' })
