import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of connections, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const CONNECTION_TYPES = ['TEAMMATE', 'COLLABORATOR', 'MENTOR', 'FRIEND', 'NETWORK'] as const

export const createConnectionSchema = z.object({
  receiverId: z.string().max(64).min(1),
  type: z.enum(CONNECTION_TYPES).default('NETWORK'),
  message: z.string().max(1000).optional(),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'BLOCKED']).optional(),
  direction: z.enum(['sent', 'received']).optional(),
  cursor: cursorParam,
})
