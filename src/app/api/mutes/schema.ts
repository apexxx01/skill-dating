import { z } from 'zod'

// The request schemas of mutes, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/mutes { userId }: hide a person from your feed, comments and lists without blocking them (they are not told, and can still interact with
// you; block for that). Idempotent: muting twice is one mute. GET: the people you muted.
export const bodySchema = z.object({ userId: z.string().min(1).max(64) }).strict()
