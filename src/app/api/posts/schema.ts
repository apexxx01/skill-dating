import { z } from 'zod'

// The request schemas of posts, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const listQuery = z.object({ cursor: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
