import { z } from 'zod'

// The request schemas of teams/[id]/keep-building, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/teams/{id}/keep-building: once the results are in or the hackathon is over, whoever runs the squad turns it into a permanent crew,
// keeping its members and roles, with its project (linked, or created from the chosen idea).
export const bodySchema = z.object({ projectName: z.string().trim().min(1).max(100).optional() }).strict()
