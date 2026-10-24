import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'
import { USER_EVIDENCE_TYPES, isHttpUrl } from '@/lib/skill-evidence'

// The request schemas of evidence, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// .strict(): a body that tries to set verifiedAt, metadata or any other
// server-controlled field is rejected outright instead of being silently
// dropped, so an attempt to forge verification is visible as a 400.
export const createEvidenceSchema = z
  .object({
    skillId: z.string().min(1).max(64),
    type: z.enum(USER_EVIDENCE_TYPES),
    title: z.string().trim().min(1).max(200),
    url: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine(isHttpUrl, 'URL must start with http:// or https://')
      .optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict()

export const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  userId: z.string().min(1).max(64).optional(),
  skillId: z.string().min(1).max(64).optional(),
  cursor: cursorParam,
})
