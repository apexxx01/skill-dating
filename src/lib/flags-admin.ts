import { z } from 'zod'
import type { FeatureFlag } from '@prisma/client'
import { FLAG_KEY_PATTERN } from '@/lib/flags'
import { isValidId } from '@/lib/progress'

// Shapes shared by the admin flag routes.

export const MAX_ALLOWLIST = 500

const description = z.string().trim().max(300)
const rolloutPercent = z.number().int().min(0).max(100)
const allowUserIds = z.array(z.string().refine(isValidId, 'must be a user id')).max(MAX_ALLOWLIST)

export const createFlagSchema = z.object({
  key: z.string().regex(FLAG_KEY_PATTERN, 'must be 2 to 64 characters: lower-case letters, digits, "-", "_" or ".", starting with a letter'),
  description: description.optional(),
  enabled: z.boolean().default(false),
  rolloutPercent: rolloutPercent.default(100),
  allowUserIds: allowUserIds.default([]),
})

export const updateFlagSchema = z.object({
  description: description.nullable().optional(),
  enabled: z.boolean().optional(),
  rolloutPercent: rolloutPercent.optional(),
  allowUserIds: allowUserIds.optional(),
})

export function flagResponse(flag: FeatureFlag) {
  return {
    key: flag.key,
    description: flag.description,
    enabled: flag.enabled,
    rolloutPercent: flag.rolloutPercent,
    allowUserIds: flag.allowUserIds,
    updatedById: flag.updatedById,
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
  }
}
