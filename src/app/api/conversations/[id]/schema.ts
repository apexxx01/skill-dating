import { z } from 'zod'
import { boundedJson } from '@/lib/api/limits'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of conversations/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  type: z.enum(['TEXT', 'IMAGE', 'FILE', 'CODE', 'LINK_PREVIEW']).default('TEXT'),
  replyToId: z.string().max(64).optional(),
  metadata: boundedJson(2048).optional(),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
  // Older messages: the nextCursor of the previous (newer) page.
  cursor: cursorParam,
})
