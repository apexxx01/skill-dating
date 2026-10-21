import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth, createApiError, readBodyText } from '@/lib/api/handler'
import {
  MAX_CHANNELS_PER_TOKEN,
  TOKEN_TTL_MS,
  authorizeChannels,
  getRealtime,
  userChannel,
} from '@/lib/infra/realtime'

// Hands the signed-in user a short-lived, subscribe-only realtime token that
// names exactly the channels they may read: their own `user:<id>`, plus any
// `conversation:<id>` or `team:<id>` they belong to. The provider's API key
// never leaves the server; the browser only receives the signed request.

const bodySchema = z.object({
  channels: z.array(z.string().max(100)).min(1).max(MAX_CHANNELS_PER_TOKEN).optional(),
})

export const POST = withAuth(
  async (request: NextRequest, { user, prisma }) => {
    // The body is optional: no body means "my own channel".
    const raw = await readBodyText(request)
    if (raw instanceof Response) return raw
    let parsed: unknown = {}
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        return createApiError('INVALID_JSON')
      }
    }
    const result = bodySchema.safeParse(parsed)
    if (!result.success) return createApiError('VALIDATION_FAILED', { details: result.error.flatten().fieldErrors })

    const requested = result.data.channels ?? [userChannel(user.id)]
    const { allowed, denied } = await authorizeChannels(prisma, user.id, requested)
    if (denied.length > 0) return createApiError('CHANNEL_FORBIDDEN', { details: { denied } })

    const tokenRequest = await getRealtime().issueToken(user.id, allowed, TOKEN_TTL_MS)
    return NextResponse.json(
      { tokenRequest, channels: allowed, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  },
  { rateLimit: { keyPrefix: 'realtime:token', windowMs: 60_000, maxRequests: 30 } }
)
