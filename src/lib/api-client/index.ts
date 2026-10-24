import { pages, collect, type ApiResponse } from './runtime'

// The typed client of the API: `createApiClient({ baseUrl, getToken, onRewards })`, then `api.shipFeed.getFeed({ query: { tab: 'city' } })`. The operations are generated from docs/openapi.json
// (`npm run openapi:client`); the runtime (fetch, errors, idempotency, pages, rewards) is hand-written in ./runtime.ts. docs/FRONTEND_CONTRACT.md says which page calls what.
export * from './generated'
export { ApiClientError, ApiNetworkError, isApiError, momentsOf, newIdempotencyKey, pages, collect, urlFor, Transport } from './runtime'
export type { ApiClientOptions, ApiResponse, CallOptions, ErrorCodeName, Moment, OperationInfo, RequestParts } from './runtime'

/**
 * Follows a list's cursor for you: `for await (const page of paginate(api.shipFeed.getFeed, { query: { tab: 'city' } })) render(page.data.items)`. Works for every operation that takes a
 * `cursor` query and answers `nextCursor` (or the X-Next-Cursor header).
 */
export function paginate<A extends { query?: object }, T>(operation: (args: A) => Promise<ApiResponse<T>>, args: A, options: { maxPages?: number } = {}): AsyncGenerator<ApiResponse<T>, void, undefined> {
  return pages((cursor) => operation({ ...args, query: { ...(args.query ?? {}), ...(cursor ? { cursor } : {}) } } as A), options)
}

/** All the items of a list: `await collectAll(api.shipFeed.getFeed, { query: { tab: 'city' } }, (page) => page.items, { maxItems: 100 })`. */
export function collectAll<A extends { query?: object }, T, I>(operation: (args: A) => Promise<ApiResponse<T>>, args: A, items: (page: T) => readonly I[], options: { maxItems?: number; maxPages?: number } = {}): Promise<I[]> {
  return collect((cursor) => operation({ ...args, query: { ...(args.query ?? {}), ...(cursor ? { cursor } : {}) } } as A), items, options)
}
