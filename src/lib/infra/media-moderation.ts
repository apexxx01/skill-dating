import { env } from '@/lib/env'
import { log } from '@/lib/log'

// Media moderation: a scanner looks at an uploaded image before anyone else can see it (romance photos and avatars, src/lib/media.ts SCANNED_PURPOSES).
// The answer is SAFE (served), NEEDS_REVIEW (held for a moderator in the queue) or BLOCKED (the object is deleted at once; only its hash, the verdict and
// the labels are kept). Callers depend on `MediaScanner`; providers are swapped by writing one class.
//
//   NoopScanner         development and tests: everything is SAFE.
//   HttpScanner         any provider behind a small JSON contract (MEDIA_MODERATION_URL, MEDIA_MODERATION_TOKEN): POST { url, contentType, sha256 }
//                       answers { verdict, labels }. A provider with another API gets an adapter service or its own class here.
//   UnavailableScanner  production without a provider: FAILS CLOSED. Uploads that must be scanned are refused (503 MEDIA_SCANNING_UNAVAILABLE).
//
// Child-safety hash matching (PhotoDNA-class) and the legal reporting duties of each launch country are NOT provided by this adapter and must be in place
// before romance photos are enabled in production: docs/SAFETY.md, "Media safety".

export type ScanVerdict = 'SAFE' | 'NEEDS_REVIEW' | 'BLOCKED'

export interface ScanResult {
  verdict: ScanVerdict
  labels: string[]
}

export interface ScanInput {
  /** A short-lived URL the provider can fetch the image from. */
  url: string
  contentType: string
  sha256: string
}

export interface MediaScanner {
  readonly kind: 'noop' | 'http' | 'unavailable'
  /** Whether uploads that must be scanned are accepted at all. */
  readonly available: boolean
  scan(input: ScanInput): Promise<ScanResult>
}

export class MediaScannerUnavailableError extends Error {
  constructor() {
    super('No media moderation provider is configured')
    this.name = 'MediaScannerUnavailableError'
  }
}

export class NoopScanner implements MediaScanner {
  readonly kind = 'noop' as const
  readonly available = true
  async scan(): Promise<ScanResult> {
    return { verdict: 'SAFE', labels: [] }
  }
}

export class UnavailableScanner implements MediaScanner {
  readonly kind = 'unavailable' as const
  readonly available = false
  async scan(): Promise<ScanResult> {
    throw new MediaScannerUnavailableError()
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

const VERDICTS: readonly ScanVerdict[] = ['SAFE', 'NEEDS_REVIEW', 'BLOCKED']

export class HttpScanner implements MediaScanner {
  readonly kind = 'http' as const
  readonly available = true

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 15_000
  ) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`media scanner answered ${response.status}`)
    const body = (await response.json()) as { verdict?: unknown; labels?: unknown }
    // Anything the provider says that is not one of the three verdicts is treated as "a person should look".
    const verdict = VERDICTS.includes(body.verdict as ScanVerdict) ? (body.verdict as ScanVerdict) : 'NEEDS_REVIEW'
    const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string').slice(0, 20).map((l) => l.slice(0, 64)) : []
    return { verdict, labels }
  }
}

export function createMediaScanner(): MediaScanner {
  if (env.MEDIA_MODERATION_URL && env.MEDIA_MODERATION_TOKEN) return new HttpScanner(env.MEDIA_MODERATION_URL, env.MEDIA_MODERATION_TOKEN)
  if (env.NODE_ENV === 'production' && !env.INTEGRATION_TEST_SERVER) {
    log.warn('no media moderation provider: romance photo and avatar uploads are refused')
    return new UnavailableScanner()
  }
  return new NoopScanner()
}

const globalForScanner = globalThis as unknown as { __mediaScanner?: MediaScanner }

export function getMediaScanner(): MediaScanner {
  if (!globalForScanner.__mediaScanner) globalForScanner.__mediaScanner = createMediaScanner()
  return globalForScanner.__mediaScanner
}

/** Replaces the process-wide scanner (tests). */
export function setMediaScanner(scanner: MediaScanner | undefined) {
  globalForScanner.__mediaScanner = scanner
}

/** Labels that mean a possible child-safety case: the report goes first in the queue as MINOR_SAFETY. */
export const isMinorSafetyLabel = (label: string) => /(minor|child|csam|underage)/i.test(label)
