import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { Cache } from '@/lib/infra/cache'
import { errorResponse } from '@/lib/api/errors'
import { log } from '@/lib/log'

// Idempotency-Key for POST routes that create things.
//
// A client that is not sure its request arrived (a timeout, a dropped
// connection, a double tap) repeats it with the same `Idempotency-Key` header and
// gets the SAME response back instead of creating a second project, message or
// team. The first response is kept for 24 hours.
//
//  - same key, same request: the stored response is replayed, with the header
//    `Idempotent-Replayed: true`;
//  - same key, different request (other path or body): 409 IDEMPOTENCY_KEY_REUSED,
//    because a key names one request, not a topic;
//  - same key while the first request is still running: 409
//    IDEMPOTENCY_REQUEST_IN_PROGRESS with `Retry-After`, never a second run.
//
// Only successful (2xx) responses are kept. A failure releases the key, so the
// client can fix the request and retry with the same key. Keys belong to the
// signed-in user: two users cannot collide or read each other's responses.
// The store is the Cache adapter (Redis in production). If it is unreachable the
// request is processed normally, since refusing every write because a cache is
// down would be worse than the rare duplicate.

export const IDEMPOTENCY_HEADER = 'Idempotency-Key'
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
export const IDEMPOTENCY_PENDING_TTL_MS = 60_000
export const MAX_STORED_BODY_BYTES = 256 * 1024

const KEY_PATTERN = /^[A-Za-z0-9._:~=+-]{8,128}$/

export function parseIdempotencyKey(header: string | null): { key: string } | { invalid: true } | null {
  if (header === null) return null
  return KEY_PATTERN.test(header) ? { key: header } : { invalid: true }
}

/** What makes two requests "the same request": method, path (query included) and body. */
export function requestFingerprint(method: string, pathWithQuery: string, body: string): string {
  return createHash('sha256').update(method).update('\0').update(pathWithQuery).update('\0').update(body).digest('hex')
}

interface Stored {
  fingerprint: string
  state: 'pending' | 'done'
  status?: number
  body?: string
  contentType?: string
}

const recordKey = (userId: string, key: string) => `idem:${userId}:${createHash('sha256').update(key).digest('hex')}`

function replay(stored: Stored): NextResponse {
  return new NextResponse(stored.body ?? null, {
    status: stored.status ?? 200,
    headers: {
      'content-type': stored.contentType ?? 'application/json',
      'Idempotent-Replayed': 'true',
    },
  })
}

/**
 * Runs `run` at most once per (user, key). `request` is read through a clone, so
 * the handler can still read the body.
 */
export async function withIdempotency(
  request: Request,
  userId: string,
  cache: Cache,
  run: () => Promise<NextResponse>
): Promise<NextResponse> {
  const parsed = parseIdempotencyKey(request.headers.get(IDEMPOTENCY_HEADER))
  if (parsed === null) return run()
  if ('invalid' in parsed) return errorResponse('IDEMPOTENCY_KEY_INVALID')

  const url = new URL(request.url)
  const fingerprint = requestFingerprint(request.method, url.pathname + url.search, await request.clone().text())
  const slot = recordKey(userId, parsed.key)

  try {
    const raw = await cache.get(slot)
    if (raw) {
      const stored = JSON.parse(raw) as Stored
      if (stored.fingerprint !== fingerprint) return errorResponse('IDEMPOTENCY_KEY_REUSED')
      if (stored.state === 'done') return replay(stored)
      return errorResponse('IDEMPOTENCY_REQUEST_IN_PROGRESS', { headers: { 'Retry-After': '1' } })
    }

    // Nothing stored yet. INCR is atomic, so of several simultaneous first requests
    // exactly one gets 1 and runs; the claim expires on its own if that request dies.
    const claimed = (await cache.incr(`${slot}:claim`, { ttlMs: IDEMPOTENCY_PENDING_TTL_MS })) === 1
    if (!claimed) return errorResponse('IDEMPOTENCY_REQUEST_IN_PROGRESS', { headers: { 'Retry-After': '1' } })
    await cache.set(slot, JSON.stringify({ fingerprint, state: 'pending' } satisfies Stored), { ttlMs: IDEMPOTENCY_PENDING_TTL_MS })
  } catch (error) {
    log.warn('idempotency store unavailable; processing the request without it', { error })
    return run()
  }

  let response: NextResponse
  try {
    response = await run()
  } catch (error) {
    await release(cache, slot)
    throw error
  }

  try {
    if (response.status >= 200 && response.status < 300) {
      const body = await response.clone().text()
      if (Buffer.byteLength(body) <= MAX_STORED_BODY_BYTES) {
        const stored: Stored = {
          fingerprint,
          state: 'done',
          status: response.status,
          body,
          contentType: response.headers.get('content-type') ?? 'application/json',
        }
        await cache.set(slot, JSON.stringify(stored), { ttlMs: IDEMPOTENCY_TTL_MS })
        return response
      }
    }
    await release(cache, slot)
  } catch (error) {
    log.warn('could not store the idempotent response', { error })
    await release(cache, slot)
  }
  return response
}

async function release(cache: Cache, slot: string) {
  try {
    await cache.del(slot)
    await cache.del(`${slot}:claim`)
  } catch (error) {
    log.warn('could not release the idempotency key; it expires on its own', { error })
  }
}
