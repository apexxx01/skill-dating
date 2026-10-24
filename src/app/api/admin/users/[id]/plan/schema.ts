import { z } from 'zod'

// The request schemas of admin/users/[id]/plan, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PUT /api/admin/users/{id}/plan { plan, until?, reason }: an entitlement override (a comped plan, a correction after a billing problem). It writes the
// person's Subscription with provider "admin", so a later billing integration can tell it apart. Admins only, with a session signed in within the last
// 10 minutes. Audited with the old and the new plan.
export const bodySchema = z
  .object({ plan: z.enum(['FREE', 'PRO', 'CREW_PRO', 'ORG']), until: z.string().max(40).datetime().optional(), reason: z.string().trim().min(3).max(1000) })
  .strict()
