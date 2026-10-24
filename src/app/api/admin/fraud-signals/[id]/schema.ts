import { z } from 'zod'

// The request schemas of admin/fraud-signals/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/admin/fraud-signals/{id} { status: CONFIRMED|DISMISSED, note? }: a person's decision on a flagged group. DISMISSED restores every weight the
// signal lowered and keeps the group from being flagged again; CONFIRMED keeps the down-weighting. Audited. Staff only. Nobody is banned by either.
export const bodySchema = z.object({ status: z.enum(['CONFIRMED', 'DISMISSED']), note: z.string().trim().max(1000).optional() }).strict()
