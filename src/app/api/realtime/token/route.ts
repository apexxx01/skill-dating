import { NextRequest, NextResponse } from 'next/server'
import { withAuth, createApiError, readBodyText } from '@/lib/api/handler'
import { TOKEN_TTL_MS, authorizeChannels, getRealtime, userChannel } from '@/lib/infra/realtime'
import { bodySchema } from './schema'

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
