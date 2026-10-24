import { z } from 'zod'

// The request schemas of campuses, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// The campuses a person can verify, for a picker: GET /api/campuses?q=&countryCode=. The domains are listed so the page can say which address to use.
export const querySchema = z.object({
  q: z.string().max(100).optional(),
  countryCode: z.string().max(2).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
