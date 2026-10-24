import { z } from 'zod'
import { MAX_CHANNELS_PER_TOKEN } from '@/lib/infra/realtime'

// The request schemas of realtime/token, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Hands the signed-in user a short-lived, subscribe-only realtime token that
// names exactly the channels they may read: their own `user:<id>`, plus any
// `conversation:<id>` or `team:<id>` they belong to. The provider's API key
// never leaves the server; the browser only receives the signed request.
export const bodySchema = z.object({
  channels: z.array(z.string().max(100)).min(1).max(MAX_CHANNELS_PER_TOKEN).optional(),
})
