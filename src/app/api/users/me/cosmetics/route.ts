import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { loadCosmetics } from '@/lib/cosmetic-view'

// The cosmetic catalog with the caller's inventory: what they own, what they wear, and what the rest takes to
// earn. Read only. Cosmetics are earned by playing (src/lib/cosmetics.ts) and cannot be bought, granted or
// requested here: the only thing a client can do with them is choose what to wear (PATCH /api/users/me/equipped).
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadCosmetics(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:cosmetics' } })
