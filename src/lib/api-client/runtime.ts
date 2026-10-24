import type { ErrorCode } from '@/lib/api/errors'
import type { RewardsEnvelope } from '@/types/api'

// The runtime of the API client (the typed operations are generated into ./generated.ts from docs/openapi.json). Plain `fetch`, no dependencies, safe in a browser, a server component or a script.
//
//   - Sign-in: `getToken()` returns the Clerk session token for each request (or null: the browser's cookie is used).
//   - Errors: a failed call throws ApiClientError, whose `code` is a code of the error catalogue (the type is the union of them), with the `status`, the `params` of the message, `details`, the
//     request id to quote, and `retryAfter` for a 429. `error.is('VALIDATION_FAILED')` narrows it; `isApiError(e, 'X')` does the same for anything caught.
//   - Idempotency: an operation marked idempotent gets an `Idempotency-Key` automatically (one per call, the same one if the call is retried), or pass your own with `idempotencyKey`.
//   - Pages: lists answer `nextCursor`; `pages()` follows it and `collect()` gathers items. A bare-array list says it in the `X-Next-Cursor` header, read into `nextCursor` too.
//   - Rewards: when an answer carries a `rewards` envelope it is returned as `response.rewards` and passed to `onRewards`, the one place the interface celebrates; `momentsOf(rewards)` lists what to celebrate.
//   - Caching: read-heavy GETs are cached by the browser for a few seconds and revalidated with an ETag; after a write of your own pass `fresh: true` to revalidate now (`cache: 'no-cache'`).

export type ErrorCodeName = ErrorCode

export interface ApiResponse<T> {
  data: T
  /** The RewardsEnvelope of the answer, when it carries one (also when nothing was earned). */
  rewards: RewardsEnvelope | null
  status: number
  /** `X-Request-Id`: quote it when reporting a problem. */
  requestId: string | null
  /** The cursor of the next page, from the body (`nextCursor`) or the `X-Next-Cursor` header; null on the last page. */
  nextCursor: string | null
  etag: string | null
}

export interface CallOptions {
  /** Revalidate with the server now instead of trusting the browser's short cache (use after a write of your own). */
  fresh?: boolean
  /** Your own Idempotency-Key for this call; a fresh one is made for an idempotent operation otherwise. */
  idempotencyKey?: string
  signal?: AbortSignal
  /** Extra headers. */
  headers?: Record<string, string>
}

export interface ApiClientOptions {
  /** Where the API is, with no trailing slash. Default: the page's own origin (an empty string). */
  baseUrl?: string
  /** The session token to send as `Authorization: Bearer`. Called for every request. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>
  fetch?: typeof fetch
  /** Called with the rewards envelope of every answer that has one. */
  onRewards?: (rewards: RewardsEnvelope, operation: string) => void
  /** Called before every request, for logging and tests. */
  onRequest?: (request: { operation: string; method: string; url: string }) => void
  /** Makes an Idempotency-Key. Default: crypto.randomUUID(). */
  makeIdempotencyKey?: () => string
  /** How many times a network failure or a 503 of an idempotent operation (or a GET) is tried again with the same key. Default 1. */
  retries?: number
}

export interface ErrorBody {
  error: { code: string; message: string; params?: Record<string, string | number | boolean>; details?: unknown }
}

export class ApiClientError<C extends ErrorCodeName = ErrorCodeName> extends Error {
  readonly name = 'ApiClientError'
  constructor(
    readonly code: C,
    readonly status: number,
    message: string,
    readonly params: Record<string, string | number | boolean>,
    readonly details: unknown,
    readonly requestId: string | null,
    readonly operation: string
  ) {
    super(message)
  }

  /** Seconds to wait, for a 429 (`RATE_LIMITED`). */
  get retryAfter(): number | null {
    const value = this.params.retryAfter
    return typeof value === 'number' ? value : null
  }

  /** Field problems of a 400 VALIDATION_FAILED, by field name. */
  get fieldErrors(): Record<string, string[]> {
    const details = this.details
    return details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, string[]>) : {}
  }

  is<K extends ErrorCodeName>(code: K): this is ApiClientError<K> {
    return (this.code as string) === code
  }
}

export function isApiError(value: unknown): value is ApiClientError
export function isApiError<K extends ErrorCodeName>(value: unknown, code: K): value is ApiClientError<K>
export function isApiError(value: unknown, code?: ErrorCodeName): boolean {
  return value instanceof ApiClientError && (code === undefined || value.code === code)
}

/** What a client did not get: a network failure, a timeout or an abort, as opposed to an answer from the API. */
export class ApiNetworkError extends Error {
  readonly name = 'ApiNetworkError'
  constructor(
    message: string,
    readonly operation: string,
    readonly cause?: unknown
  ) {
    super(message)
  }
}

export interface OperationInfo {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  idempotent: boolean
  /** Whether a failed call may be tried again (a GET, or an idempotent operation). */
  safeToRetry: boolean
}

export interface RequestParts {
  path?: Record<string, string | number>
  query?: object
  body?: unknown
}

const isEnvelope = (value: unknown): value is RewardsEnvelope =>
  typeof value === 'object' && value !== null && typeof (value as RewardsEnvelope).xpGained === 'number' && typeof (value as RewardsEnvelope).totalXp === 'number' && typeof (value as RewardsEnvelope).streak === 'object'

export function urlFor(info: OperationInfo, parts: RequestParts, baseUrl: string): string {
  const path = info.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = parts.path?.[name]
    if (value === undefined) throw new Error(`${info.method} ${info.path} needs the path parameter ${name}`)
    return encodeURIComponent(String(value))
  })
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries((parts.query ?? {}) as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    for (const one of Array.isArray(value) ? value : [value]) query.append(key, String(one))
  }
  const text = query.toString()
  return `${baseUrl}${path}${text ? `?${text}` : ''}`
}

export class Transport {
  constructor(private readonly options: ApiClientOptions = {}) {}

  async call<T>(operation: string, info: OperationInfo, parts: RequestParts = {}, call: CallOptions = {}): Promise<ApiResponse<T>> {
    const fetcher = this.options.fetch ?? fetch
    const url = urlFor(info, parts, this.options.baseUrl ?? '')
    const headers: Record<string, string> = { accept: 'application/json', ...(call.headers ?? {}) }
    const token = await this.options.getToken?.()
    if (token) headers.authorization = `Bearer ${token}`
    let body: string | undefined
    if (parts.body !== undefined) {
      body = JSON.stringify(parts.body)
      headers['content-type'] = 'application/json'
    }
    if (info.idempotent) headers['idempotency-key'] = call.idempotencyKey ?? (this.options.makeIdempotencyKey ?? (() => crypto.randomUUID()))()
    const attempts = 1 + (info.safeToRetry ? (this.options.retries ?? 1) : 0)
    let lastNetworkError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.options.onRequest?.({ operation, method: info.method, url })
      let response: Response
      try {
        response = await fetcher(url, { method: info.method, headers, body, signal: call.signal, ...(call.fresh ? { cache: 'no-cache' as RequestCache } : {}) })
      } catch (error) {
        lastNetworkError = error
        if (call.signal?.aborted || attempt === attempts) throw new ApiNetworkError(`${operation}: ${error instanceof Error ? error.message : 'the request failed'}`, operation, error)
        continue
      }
      // The same request is tried again after a 503 when that is safe (the Idempotency-Key is the same, so nothing is done twice).
      if (response.status === 503 && attempt < attempts) continue
      return this.read<T>(operation, response)
    }
    throw new ApiNetworkError(`${operation}: the request failed`, operation, lastNetworkError)
  }

  /** The raw Response, for the operations that answer with a file or an image (the CSV exports, the share cards). Errors are still thrown as ApiClientError. */
  async raw(operation: string, info: OperationInfo, parts: RequestParts = {}, call: CallOptions = {}): Promise<Response> {
    const fetcher = this.options.fetch ?? fetch
    const token = await this.options.getToken?.()
    this.options.onRequest?.({ operation, method: info.method, url: urlFor(info, parts, this.options.baseUrl ?? '') })
    const response = await fetcher(urlFor(info, parts, this.options.baseUrl ?? ''), { method: info.method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(call.headers ?? {}) }, signal: call.signal })
    if (!response.ok) await this.read(operation, response)
    return response
  }

  private async read<T>(operation: string, response: Response): Promise<ApiResponse<T>> {
    const requestId = response.headers.get('x-request-id')
    const text = response.status === 204 || response.status === 304 ? '' : await response.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    if (!response.ok && response.status !== 304) {
      const error = (json as ErrorBody | null)?.error
      throw new ApiClientError(
        ((error?.code as ErrorCodeName | undefined) ?? 'INTERNAL_ERROR') as ErrorCodeName,
        response.status,
        error?.message ?? `${operation} failed with ${response.status}`,
        error?.params ?? {},
        error?.details,
        requestId,
        operation
      )
    }
    const rewards = json && typeof json === 'object' && isEnvelope((json as { rewards?: unknown }).rewards) ? ((json as { rewards: RewardsEnvelope }).rewards) : null
    if (rewards) this.options.onRewards?.(rewards, operation)
    const bodyCursor = json && typeof json === 'object' && typeof (json as { nextCursor?: unknown }).nextCursor === 'string' ? (json as { nextCursor: string }).nextCursor : null
    return { data: json as T, rewards, status: response.status, requestId, nextCursor: bodyCursor ?? response.headers.get('x-next-cursor'), etag: response.headers.get('etag') }
  }
}

// --- Pages ------------------------------------------------------------------------------------------------------------------------

/** Follows `nextCursor`: yields each page's response until there is no next page. `limit` stops after that many pages. */
export async function* pages<T>(fetchPage: (cursor: string | undefined) => Promise<ApiResponse<T>>, options: { maxPages?: number } = {}): AsyncGenerator<ApiResponse<T>, void, undefined> {
  let cursor: string | undefined
  for (let count = 0; options.maxPages === undefined || count < options.maxPages; count++) {
    const page = await fetchPage(cursor)
    yield page
    if (!page.nextCursor) return
    cursor = page.nextCursor
  }
}

/** All the items of a list, page after page: `items` says where they are in one page's body. */
export async function collect<T, I>(fetchPage: (cursor: string | undefined) => Promise<ApiResponse<T>>, items: (page: T) => readonly I[], options: { maxItems?: number; maxPages?: number } = {}): Promise<I[]> {
  const out: I[] = []
  for await (const page of pages(fetchPage, { maxPages: options.maxPages })) {
    out.push(...items(page.data))
    if (options.maxItems !== undefined && out.length >= options.maxItems) return out.slice(0, options.maxItems)
  }
  return out
}

// --- Rewards ----------------------------------------------------------------------------------------------------------------------

export type Moment =
  | { kind: 'LEVEL_UP'; level: number; tier: RewardsEnvelope['newTier'] }
  | { kind: 'TIER_UP'; from: RewardsEnvelope['oldTier']; to: RewardsEnvelope['newTier'] }
  | { kind: 'ACHIEVEMENT'; slug: string; name: string }
  | { kind: 'QUEST_COMPLETED'; slug: string; name: string }
  | { kind: 'STREAK_EXTENDED'; current: number; longest: number }
  | { kind: 'STREAK_SAVED'; current: number }
  | { kind: 'XP'; amount: number; total: number }

/**
 * What the interface should celebrate for a rewards envelope, most special first: a tier-up, a level-up, each achievement, each quest, the streak growing or saved by a freeze, then plain XP.
 * (A match, a squad forming and a shipped project are in the body of their own answers: see docs/FRONTEND_CONTRACT.md "Moments to celebrate".)
 */
export function momentsOf(rewards: RewardsEnvelope): Moment[] {
  const out: Moment[] = []
  if (rewards.tierChanged) out.push({ kind: 'TIER_UP', from: rewards.oldTier, to: rewards.newTier })
  if (rewards.leveledUp) out.push({ kind: 'LEVEL_UP', level: rewards.newLevel, tier: rewards.newTier })
  for (const achievement of rewards.achievements) out.push({ kind: 'ACHIEVEMENT', slug: achievement.slug, name: achievement.name })
  for (const quest of rewards.questsCompleted) out.push({ kind: 'QUEST_COMPLETED', slug: quest.slug, name: quest.name })
  if (rewards.streak.freezeUsed) out.push({ kind: 'STREAK_SAVED', current: rewards.streak.current })
  else if (rewards.streak.extended && rewards.streak.current > 1) out.push({ kind: 'STREAK_EXTENDED', current: rewards.streak.current, longest: rewards.streak.longest })
  if (rewards.xpGained > 0) out.push({ kind: 'XP', amount: rewards.xpGained, total: rewards.totalXp })
  return out
}

/** A fresh Idempotency-Key: use one per user action and send it again when you retry that action. */
export const newIdempotencyKey = (): string => crypto.randomUUID()
