import { createHash } from 'crypto'
import { NextResponse } from 'next/server'

// HTTP caching for the read-heavy GETs (docs/PERFORMANCE.md, "Caching"). Every answer is about the signed-in person, so it is PRIVATE (a shared cache must never keep it) and says
// `Vary: Authorization, Cookie`; a route opts in with a short max-age (seconds) so a browser that asks again at once reuses the answer, and every opted-in answer carries an ETag, so a
// client that asks after the max-age sends `If-None-Match` and is told 304 with no body when nothing changed. The ETag is a hash of the body that was about to be sent: it costs one
// SHA-1 of a few kilobytes and saves the bytes (not the query: the work is done to know the body). A route that already set Cache-Control is left alone.
//
// After a write of your own, a client that wants the current answer asks with `Cache-Control: no-cache` (fetch: `cache: 'no-cache'`): the browser skips the max-age and revalidates with the
// ETag, so it is told 304 if nothing changed and sent the new body if the write did.

export interface CachePolicy {
  /** How long a browser may reuse the answer without asking, in seconds. 0: always ask, but a 304 is still a saving. */
  maxAge: number
}

export const cacheControlOf = (policy: CachePolicy): string => `private, max-age=${policy.maxAge}${policy.maxAge === 0 ? ', must-revalidate' : ''}`

/** A weak validator for a body: the same text gives the same tag. */
export function etagOf(body: string): string {
  return `W/"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`
}

/** Whether an `If-None-Match` header names this tag (a list of tags, or *). Weak comparison, as RFC 9110 says for GET. */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  const bare = (tag: string) => tag.trim().replace(/^W\//, '')
  return header.split(',').some((candidate) => bare(candidate) === bare(etag))
}

/** Adds the caching headers to a successful GET answer, or turns it into a 304 when the client already has it. Anything else is returned as it came. */
export async function applyHttpCache(request: Request, response: NextResponse, policy: CachePolicy): Promise<NextResponse> {
  if (request.method !== 'GET' || response.status !== 200 || response.headers.has('Cache-Control')) return response
  const body = await response.text()
  const etag = etagOf(body)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('Cache-Control', cacheControlOf(policy))
  headers.set('ETag', etag)
  headers.append('Vary', 'Authorization, Cookie')
  // A client that revalidates (`Cache-Control: no-cache`, which fetch sends with a conditional request too) is asking whether what it has is still right: 304 if it is, the new body if not.
  if (matchesEtag(request.headers.get('if-none-match'), etag)) {
    headers.delete('content-type')
    return new NextResponse(null, { status: 304, headers })
  }
  return new NextResponse(body, { status: 200, headers })
}
