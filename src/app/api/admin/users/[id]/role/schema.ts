import { z } from 'zod'

// The request schemas of admin/users/[id]/role, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/admin/users/{id}/role { role: USER|MODERATOR|ADMIN, reason }: who is staff. Admins only, with a session signed in within the last 10 minutes;
// an admin cannot change their own role (so the last admin cannot lock everyone out by mistake). Audited.
export const bodySchema = z.object({ role: z.enum(['USER', 'MODERATOR', 'ADMIN']), reason: z.string().trim().min(3).max(1000) }).strict()
