import { NextResponse, type NextRequest } from 'next/server'
import { errorResponse } from '@/lib/api/errors'
import { isReceiptId } from '@/lib/evidence/receipt-id'
import { publicReceipt } from '@/lib/evidence/receipts'
import { getCache } from '@/lib/infra/cache'
import { log, requestIdFrom, runWithRequestId } from '@/lib/log'
import { isKilled } from '@/lib/ops/kill-switches'
import { matchesEtag } from '@/lib/og/render'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limiter'

// GET /api/receipts/{id}: one receipt, public (signed in or not), for the verify page and for anybody checking a receipt somebody showed them: the signed
// envelope, the signature, its status and the owner's public handle (src/lib/evidence/receipts.ts publicReceipt has the rules). 404 RECEIPT_NOT_FOUND for
// a receipt that does not exist and for one that may not be shown, alike; 410 RECEIPT_REVOKED for a revoked receipt or a deleted account; 503
// RECEIPTS_PAUSED under the receipts-public kill switch. Rate limited by address; cached five minutes with an ETag (304 when unchanged).
export const dynamic = 'force-dynamic'

const CACHE = 'public, max-age=300'
const MISSING = { 'Cache-Control': 'public, max-age=60' }

export async function GET(request: NextRequest) {
  return runWithRequestId(requestIdFrom(request.headers), async () => {
    const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: 'receipts:get' })
    if (limited) return limited
    if (await isKilled(prisma, 'receipts_public', getCache())) return errorResponse('RECEIPTS_PAUSED')
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
    if (!isReceiptId(id)) return errorResponse('RECEIPT_NOT_FOUND', { headers: MISSING })
    try {
      const outcome = await publicReceipt(prisma, id)
      if (outcome.kind === 'not-found') return errorResponse('RECEIPT_NOT_FOUND', { headers: MISSING })
      if (outcome.kind === 'gone') return errorResponse('RECEIPT_REVOKED', { headers: MISSING })
      if (matchesEtag(request.headers.get('if-none-match'), outcome.etag)) return new NextResponse(null, { status: 304, headers: { ETag: outcome.etag, 'Cache-Control': CACHE } })
      return NextResponse.json(outcome.body, { headers: { ETag: outcome.etag, 'Cache-Control': CACHE, 'Access-Control-Allow-Origin': '*' } })
    } catch (error) {
      log.error('could not read a receipt', { error })
      return errorResponse('INTERNAL_ERROR')
    }
  })
}
