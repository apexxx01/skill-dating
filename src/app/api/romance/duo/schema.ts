import { z } from 'zod'

// The request schemas of romance/duo, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json, src/lib/openapi) reads these.

export const requestDuoSchema = z.object({ matchId: z.string().min(1).max(64) }).strict()
