import { z } from 'zod'
import { squadRoleSchema } from '@/lib/squads/schemas'

// The request schemas of teams/[id]/members/[userId], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// `role` is the member's permissions (owner only); `squadRole` (+ `roleLabel` for OTHER) is what they do on the squad, which a member may declare
// for themselves and the owner for anyone.
export const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  squadRole: squadRoleSchema.nullable().optional(),
  roleLabel: z.string().trim().min(1).max(40).nullable().optional(),
}).refine((value) => value.role !== undefined || value.squadRole !== undefined, 'Send role or squadRole')
