import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/api/errors'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limiter'
import { appBaseUrl } from '@/lib/notify/base-url'
import { applyUnsubscribe } from '@/lib/notify/settings'
import { DEFAULT_LOCALE } from '@/lib/notify/strings'
import { readUnsubscribeToken } from '@/lib/notify/tokens'
import { htmlResponse, invalidLinkPage, unsubscribedPage } from '@/lib/notify/unsubscribe-page'

// The unsubscribe link in every optional email (docs/NOTIFICATIONS.md, "Compliance"). Unauthenticated by design: the signed token in `t` is the credential, and
// it says who and for what (one kind, or ALL). Two ways in:
//   POST   what a mail client does for the List-Unsubscribe-Post header (RFC 8058): one click, no page. Answers JSON.
//   GET    what the link in the body of the email opens: unsubscribes and shows a plain confirmation page. (A scanner that opens links can therefore unsubscribe
//          someone; that is why the headers, not the link, are what mail clients use, and why settings can always switch a kind back on.)
// Nothing here can switch off an account or safety notice.

export const dynamic = 'force-dynamic'

const LIMIT = { windowMs: 60_000, maxRequests: 30, keyPrefix: 'notifications:unsubscribe' }
const settingsUrl = () => `${appBaseUrl()}/settings/notifications`

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, LIMIT)
  if (limited) return limited
  const scope = readUnsubscribeToken(new URL(request.url).searchParams.get('t') ?? '')
  if (!scope) return htmlResponse(invalidLinkPage(DEFAULT_LOCALE, settingsUrl()), 400)
  await applyUnsubscribe(prisma, scope)
  return htmlResponse(unsubscribedPage(DEFAULT_LOCALE, scope, settingsUrl()), 200)
}

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, LIMIT)
  if (limited) return limited
  const scope = readUnsubscribeToken(new URL(request.url).searchParams.get('t') ?? '')
  if (!scope) return errorResponse('UNSUBSCRIBE_LINK_INVALID')
  const { applied } = await applyUnsubscribe(prisma, scope)
  return NextResponse.json({ success: true, applied, kind: scope.kind })
}
