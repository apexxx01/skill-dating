import { z } from 'zod'
import { REPORT_REASONS } from '@/lib/moderation/reports'

// The request schemas of admin/queue, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/admin/queue?kind=reports|appeals&reason=&offset=: open reports, most urgent first (minor safety, the romance mode, impersonation, then by the
// reporter's standing and how many people reported it), or pending appeals, oldest first. Staff only.
export const querySchema = z.object({
  kind: z.enum(['reports', 'appeals']).default('reports'),
  reason: z.enum(REPORT_REASONS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})
