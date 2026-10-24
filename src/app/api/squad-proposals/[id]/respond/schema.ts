import { z } from 'zod'

// The request schemas of squad-proposals/[id]/respond, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/squad-proposals/{id}/respond { accept }: a member's answer to a squad the solo pool proposed. The squad forms (or fails) as soon as
// everybody has answered, else when its day is up.
export const bodySchema = z.object({ accept: z.boolean() }).strict()
