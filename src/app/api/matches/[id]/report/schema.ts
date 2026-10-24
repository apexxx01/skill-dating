import { z } from 'zod'

// The request schemas of matches/[id]/report, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'FAKE_PROFILE', 'SCAM', 'COPYRIGHT', 'OTHER'] as const

export const bodySchema = z.object({ reason: z.enum(REPORT_REASONS), description: z.string().max(5000).optional() }).strict()
