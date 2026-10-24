import { z } from 'zod'

// The request schemas of campus/verification, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/campus/verification: mails a six-digit code to a campus e-mail address, good for 15 minutes and 5 tries (docs/INVITES.md). At most 5 a hour. The address is
// used to send the code and is erased when the code is confirmed or has expired; it is never returned.
export const bodySchema = z.object({ campusId: z.string().min(1).max(64), email: z.string().max(254) }).strict()
