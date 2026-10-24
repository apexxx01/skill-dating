import { z } from 'zod'

// The request schemas of invites/check, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/invites/check?code=: for the sign-up page, before the person has an account. Public, so limited by address, tightly: it answers only { valid }, the same
// no for a code that never existed and one that was switched off, ran out or expired, and never whose it is or which campus it names (docs/INVITES.md).
export const querySchema = z.object({ code: z.string().trim().min(1).max(64) }).strict()
