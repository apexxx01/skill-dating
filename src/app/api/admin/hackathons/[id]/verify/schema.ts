import { z } from 'zod'

// The request schemas of admin/hackathons/[id]/verify, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PATCH /api/admin/hackathons/{id}/verify { verified }: an admin vouches for an external hackathon (it then pays XP like a native one), or takes
// that back. Native hackathons are always verified.
export const bodySchema = z.object({ verified: z.boolean() }).strict()
