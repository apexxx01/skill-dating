import { z } from 'zod'
import { MAX_SEED } from '@/lib/squads/optimizer'

// The request schemas of hackathons/[id]/squad-builder, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/hackathons/{id}/squad-builder ("Find my squad"): a complete squad of a sensible size proposed around the caller, from the hackathon's solo
// pool, with each person's role and reasons and the squad's strength (docs/SQUADS.md, "The squad builder"). The proposal is kept for 24 hours for
// the invite step. Deterministic for a seed; bounded work.
export const bodySchema = z
  .object({
    size: z.number().int().min(1).max(10).optional(),
    seed: z.number().int().min(0).max(MAX_SEED).optional(),
    tracks: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
  })
  .strict()
