import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { equip } from '@/lib/cosmetics'
import { invalidateUserViews } from '@/lib/xp-views'
import { bodySchema } from './schema'

// Chooses what the caller wears. Title, frame and banner are the slug of a cosmetic they have EARNED and that goes in that
// slot, or null to take it off; badges is a list of up to three earned badges (the whole list is replaced); a slot left out is unchanged. This cannot give anybody a cosmetic: an
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
