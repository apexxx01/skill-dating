import { z } from 'zod'

// The request schemas of campus/verification/confirm, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/campus/verification/confirm { code }: the person becomes a member of the campus (its leaderboard and feed) when the code is right. Five tries, then the code is void.
export const bodySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'The six digits from the e-mail') }).strict()
