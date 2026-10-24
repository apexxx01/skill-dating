import { z } from 'zod'

// The request schemas of teams/[id]/invitations, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const inviteSchema = z.object({
  userId: z.string().max(64).min(1),
  message: z.string().max(1000).optional(),
  // The open slot the invitee is asked to fill.
  slotId: z.string().min(1).max(64).optional(),
})
