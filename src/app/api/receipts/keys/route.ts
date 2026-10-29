import { NextResponse, type NextRequest } from 'next/server'
import { getKeySet } from '@/lib/evidence/keys'
import { publicKeySet } from '@/lib/evidence/signing'
import { enforceRateLimit } from '@/lib/rate-limiter'
import { requestIdFrom, runWithRequestId } from '@/lib/log'

// GET /api/receipts/keys: the public keys receipts are signed with, JWKS-style ({ keys: [{ kty, crv, x, kid, use, alg, active }], mode }), public. Every key
// that may have signed a receipt is listed, the active one marked. Never a private part. Up even while receipt pages are switched off, so receipts copied
// elsewhere can still be verified. Cached for an hour.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  return runWithRequestId(requestIdFrom(request.headers), async () => {
    const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: 'receipts:keys' })
    if (limited) return limited
    return NextResponse.json(publicKeySet(getKeySet()), { headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } })
  })
}
