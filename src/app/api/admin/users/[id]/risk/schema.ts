import { z } from 'zod'

// The request schemas of admin/users/[id]/risk, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// GET /api/admin/users/{id}/risk: the person's risk score, its parts, and any override. PATCH { level: LOW|ELEVATED|HIGH|null, reason }: an override that
// wins over the computed level (null clears it). Reversible, audited. Staff only.
export const bodySchema = z.object({ level: z.enum(['LOW', 'ELEVATED', 'HIGH']).nullable(), reason: z.string().trim().min(3).max(1000) }).strict()
