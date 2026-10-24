import { z } from 'zod'

// The request schemas of admin/users, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/admin/users?q=: find a person by id, username (exact, then prefix) or e-mail. Searching by e-mail, and seeing e-mail addresses, is for admins
// only (403 FORBIDDEN for a moderator). Each result carries the role, verification, risk and restrictions in force. Staff only; every search is audited.
export const querySchema = z.object({ q: z.string().trim().min(2).max(200), limit: z.coerce.number().int().min(1).max(25).default(10) })
