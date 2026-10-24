import { z } from 'zod'

// The request schemas of hackathons/[id]/squad-builder/[proposalId]/invite, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/hackathons/{id}/squad-builder/{proposalId}/invite: turns the caller's proposal into a team (theirs, or a new one) and a 48-hour slot
// invitation for every proposed person who is still free, in one call. A proposal is used once; send an Idempotency-Key to retry safely.
export const bodySchema = z.object({ teamName: z.string().trim().min(1).max(100).optional() }).strict()
