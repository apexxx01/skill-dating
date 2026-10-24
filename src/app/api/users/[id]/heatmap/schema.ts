import { z } from 'zod'
import { MAX_HEATMAP_DAYS } from '@/lib/heatmap'

// The request schemas of users/[id]/heatmap, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const querySchema = z.object({ days: z.coerce.number().int().min(1).max(MAX_HEATMAP_DAYS).default(MAX_HEATMAP_DAYS) })
