import { z } from 'zod'

// The request schemas of admin/actions/[id]/reverse, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/admin/actions/{id}/reverse { reason }: takes an action back (restrictions lifted, hidden content shown again; removed text stays removed).
// Audited; the person is told. Staff only.
export const bodySchema = z.object({ reason: z.string().trim().min(3).max(2000) }).strict()
