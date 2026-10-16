import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { equip } from '@/lib/cosmetics'
import { invalidateUserViews } from '@/lib/xp-views'

const slug = z.string().trim().min(1).max(64).nullable()

const bodySchema = z
  .object({ title: slug, frame: slug, banner: slug })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one of title, frame, banner')

// Chooses what the caller wears. Each slot is the slug of a cosmetic they have EARNED and that goes in that
// slot, or null to take it off; a slot left out is unchanged. This cannot give anybody a cosmetic: an
// unearned or unknown slug is 403 COSMETIC_NOT_OWNED.
export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const outcome = await equip(prisma, user.id, body.data)
  if (!outcome.ok) {
    return outcome.reason === 'NOT_OWNED' ? createApiError('COSMETIC_NOT_OWNED') : createApiError('COSMETIC_WRONG_SLOT')
  }

  // The player card shows what is worn.
  await invalidateUserViews(user.id).catch(() => undefined)
  return createApiResponse({ equipped: outcome.equipped })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'users:equipped' } })
