import { isValidEmoji } from '@/lib/messaging'
import { z } from 'zod'

// The request schemas of messages/[id]/reactions, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const reactSchema = z.object({
  emoji: z.string().min(1).max(16).refine(isValidEmoji, 'Must be a single emoji'),
})
