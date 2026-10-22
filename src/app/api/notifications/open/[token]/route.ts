import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limiter'
import { log } from '@/lib/log'
import { appBaseUrl } from '@/lib/notify/base-url'
import { readOpenToken } from '@/lib/notify/tokens'

// Where the buttons and links in an email go (docs/NOTIFICATIONS.md): records that the email was opened (a click-through; no tracking pixel is used) and sends the
// person on to the page the email was about. Unauthenticated by design: the signed token is the credential, and the destination is signed into it, so this can
// never be turned into a redirect to another site. A bad token still lands in the app, at the front door.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 120, keyPrefix: 'notifications:open' })
  if (limited) return limited
  const base = appBaseUrl()
  const token = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
  const target = readOpenToken(token)
  if (!target) return NextResponse.redirect(`${base}/`, 302)
  try {
    await prisma.notificationDelivery.updateMany({ where: { id: target.deliveryId, channel: 'EMAIL', openedAt: null }, data: { openedAt: new Date() } })
  } catch (error) {
    // Measuring must never stand between a person and the page they clicked for.
    log.warn('could not record an email open', { error })
  }
  return NextResponse.redirect(`${base}${target.path}`, 302)
}
