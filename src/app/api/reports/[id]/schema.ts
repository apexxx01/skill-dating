import { z } from 'zod'

// The request schemas of reports/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const updateReportSchema = z.object({
  status: z.enum(['REVIEWING', 'RESOLVED', 'DISMISSED']),
  reason: z.string().max(2000).optional(),
})
