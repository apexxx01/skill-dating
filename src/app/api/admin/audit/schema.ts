import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of admin/audit, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/admin/audit?actorId=&targetId=&targetType=&action=&cursor=: the audit log, newest first. Admins only. IP addresses and user agents are not
// returned (they are kept for incident response, docs/SECURITY.md).
export const querySchema = z.object({
  actorId: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(64).optional(),
  targetType: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorParam,
})
