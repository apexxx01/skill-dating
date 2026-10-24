import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createApiClient, OPERATIONS, ApiClientError, ApiNetworkError, isApiError, momentsOf, paginate, collectAll, urlFor } from './index'
import type { RewardsEnvelope } from '@/types/api'
import { generate } from '../../../scripts/openapi/build-client'

const ROOT = path.resolve(__dirname, '../../..')
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/openapi.json'), 'utf-8')) as { paths: Record<string, Record<string, { operationId: string }>> }

const envelope = (over: Partial<RewardsEnvelope> = {}): RewardsEnvelope => ({
  xpGained: 15, totalXp: 115, oldLevel: 3, newLevel: 3, leveledUp: false, oldTier: 'BRONZE' as never, newTier: 'BRONZE' as never, tierChanged: false, achievements: [], questsCompleted: [],
  streak: { current: 1, longest: 1, extended: false, freezeUsed: false }, ...over,
})

type Call = { url: string; init: RequestInit }
function fakeFetch(answers: (Response | Error | ((call: Call) => Response))[]) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const next = answers.length > 1 ? answers.shift()! : answers[0]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(call) : next.clone()
  })
  return { fn: fn as unknown as typeof fetch, calls }
}
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...(init.headers ?? {}) }, ...init })
const failure = (status: number, code: string, extra: Record<string, unknown> = {}) => json({ error: { code, message: `${code} happened`, ...extra } }, { status })

describe('the generated client', () => {
  it('has one operation for every operation of docs/openapi.json, and the generated file is what the spec says today', async () => {
    const ids = Object.values(spec.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId)).sort()
    expect(Object.keys(OPERATIONS).sort()).toEqual(ids)
    expect(fs.readFileSync(path.join(ROOT, 'src/lib/api-client/generated.ts'), 'utf-8') === (await generate()), 'run npm run openapi:client').toBe(true)
  })

  it('builds the address from the path parameters (encoded) and the query (arrays repeated, absent values left out)', () => {
    expect(urlFor(OPERATIONS.getUsersByIdHeatmap, { path: { id: 'a b/c' }, query: { days: 30, empty: undefined, nothing: null } }, 'https://api.test')).toBe('https://api.test/api/users/a%20b%2Fc/heatmap?days=30')
    expect(urlFor(OPERATIONS.getFeed, { query: { tab: 'city', tags: ['a', 'b'] } }, '')).toBe('/api/feed?tab=city&tags=a&tags=b')
    expect(() => urlFor(OPERATIONS.getUsersByIdHeatmap, {}, '')).toThrow(/needs the path parameter id/)
  })

  it('sends the session token, the query, and reads the answer with its request id', async () => {
    const { fn, calls } = fakeFetch([json({ tab: 'city', posts: [], nextCursor: null })])
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 'tok', fetch: fn })
    const res = await api.shipFeed.getFeed({ query: { tab: 'city', limit: 5 } })
    expect(calls[0].url).toBe('https://api.test/api/feed?tab=city&limit=5')
    expect(calls[0].init.method).toBe('GET')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(res.data.posts).toEqual([])
    expect(res.requestId).toBe('req-1')
    expect(res.rewards).toBeNull()
    expect(res.nextCursor).toBeNull()
  })

  it('throws a typed error from the catalogue, with the parameters of the message and the request id', async () => {
    const { fn } = fakeFetch([failure(429, 'RATE_LIMITED', { params: { retryAfter: 12 } })])
    const api = createApiClient({ fetch: fn })
    const error = await api.shipFeed.getFeed().catch((e) => e)
    expect(error).toBeInstanceOf(ApiClientError)
    expect(isApiError(error, 'RATE_LIMITED')).toBe(true)
    expect(isApiError(error, 'NOT_A_THING' as never)).toBe(false)
    expect(error.status).toBe(429)
    expect(error.retryAfter).toBe(12)
    expect(error.requestId).toBe('req-1')
    if (error.is('RATE_LIMITED')) expect(error.code).toBe('RATE_LIMITED')

    const { fn: validation } = fakeFetch([failure(400, 'VALIDATION_FAILED', { details: { title: ['Required'] } })])
    const bad = await createApiClient({ fetch: validation }).shipFeed.postPosts({ body: { kind: 'UPDATE', title: '', body: 'x' } }).catch((e) => e)
    expect(bad.fieldErrors).toEqual({ title: ['Required'] })
  })

  it('treats an answer that is not the API’s (a gateway page) as an INTERNAL_ERROR with the status', async () => {
    const { fn } = fakeFetch([new Response('<html>bad gateway</html>', { status: 502 })])
    const error = await createApiClient({ fetch: fn }).shipFeed.getFeed().catch((e) => e)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 502 })
  })

  it('gives a creating call an Idempotency-Key of its own, the same one when it is tried again, and none to a call that does not create', async () => {
    const { fn, calls } = fakeFetch([new Response('unavailable', { status: 503 }), json({ post: { id: 'p1' }, shipped: false, rewards: envelope() }, { status: 201 })])
    const api = createApiClient({ fetch: fn, makeIdempotencyKey: () => 'key-1', retries: 1 })
    const res = await api.shipFeed.postPosts({ body: { kind: 'UPDATE', title: 'Hello', body: 'World' } })
    expect(res.status).toBe(201)
    expect(calls).toHaveLength(2)
    expect((calls[0].init.headers as Record<string, string>)['idempotency-key']).toBe('key-1')
    expect((calls[1].init.headers as Record<string, string>)['idempotency-key']).toBe('key-1')
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ title: 'Hello' })

    const own = fakeFetch([json({ items: [] })])
    await createApiClient({ fetch: own.fn }).shipFeed.getFeed()
    expect((own.calls[0].init.headers as Record<string, string>)['idempotency-key']).toBeUndefined()

    const custom = fakeFetch([json({ post: {}, shipped: false, rewards: envelope() })])
    await createApiClient({ fetch: custom.fn }).shipFeed.postPosts({ body: { kind: 'UPDATE', title: 'Hello', body: 'World' }, idempotencyKey: 'mine' })
    expect((custom.calls[0].init.headers as Record<string, string>)['idempotency-key']).toBe('mine')
  })

  it('does not try a write again that has no Idempotency-Key, and says when the network failed', async () => {
    const { fn, calls } = fakeFetch([new Error('offline')])
    const api = createApiClient({ fetch: fn, retries: 3 })
    const error = await api.messaging.deleteBlocksByUserId({ path: { userId: 'u1' } }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiNetworkError)
    expect(calls).toHaveLength(1)
    const reads = fakeFetch([new Error('offline')])
    await createApiClient({ fetch: reads.fn, retries: 2 }).shipFeed.getFeed().catch(() => undefined)
    expect(reads.calls).toHaveLength(3)
  })

  it('surfaces the RewardsEnvelope of an answer, also to the one callback, and lists what to celebrate', async () => {
    const earned = envelope({ xpGained: 75, totalXp: 900, oldLevel: 9, newLevel: 10, leveledUp: true, tierChanged: true, oldTier: 'BRONZE' as never, newTier: 'SILVER' as never, achievements: [{ slug: 'first-ship', name: 'First ship' }], streak: { current: 7, longest: 7, extended: true, freezeUsed: false } })
    const { fn } = fakeFetch([json({ post: { id: 'p1' }, shipped: true, rewards: earned }, { status: 201 })])
    const seen = vi.fn()
    const res = await createApiClient({ fetch: fn, onRewards: seen }).shipFeed.postPosts({ body: { kind: 'SHIP', title: 'Shipped it', body: 'Done', projectId: 'pr1' } })
    expect(res.rewards).toEqual(earned)
    expect(seen).toHaveBeenCalledWith(earned, 'postPosts')
    expect(momentsOf(earned).map((m) => m.kind)).toEqual(['TIER_UP', 'LEVEL_UP', 'ACHIEVEMENT', 'STREAK_EXTENDED', 'XP'])
    expect(momentsOf(envelope({ xpGained: 0 }))).toEqual([])
    expect(momentsOf(envelope({ xpGained: 0, streak: { current: 12, longest: 12, extended: false, freezeUsed: true } })).map((m) => m.kind)).toEqual(['STREAK_SAVED'])
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('reads the next cursor from the body or from the X-Next-Cursor header, and follows it', async () => {
    const pagesOfFeed = [json({ items: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' }), json({ items: [{ id: 3 }], nextCursor: 'c2' }), json({ items: [{ id: 4 }], nextCursor: null })]
    const first = fakeFetch(pagesOfFeed.map((r) => r))
    // The fake answers in order: give it a function that picks by call number.
    let n = 0
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      first.calls.push({ url, init })
      return pagesOfFeed[n++].clone()
    }) as unknown as typeof fetch
    const api = createApiClient({ fetch: fn })
    const ids: number[] = []
    for await (const page of paginate(api.shipFeed.getFeed, { query: { tab: 'for-you' as const } })) ids.push(...(page.data as unknown as { items: { id: number }[] }).items.map((i) => i.id))
    expect(ids).toEqual([1, 2, 3, 4])
    expect(first.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('cursor'))).toEqual([null, 'c1', 'c2'])

    n = 0
    const all = await collectAll(api.shipFeed.getFeed, { query: { tab: 'for-you' as const } }, (page) => (page as unknown as { items: number[] }).items, { maxItems: 3 })
    expect(all).toHaveLength(3)

    const header = fakeFetch([json([{ id: 1 }], { headers: { 'x-next-cursor': 'h1' } })])
    const res = await createApiClient({ fetch: header.fn }).passport.getUsersByIdSkills({ path: { id: 'u1' } })
    expect(res.nextCursor).toBe('h1')
  })

  it('revalidates with fresh: true, and returns a 304 as an answer, not an error', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 304, headers: { etag: 'W/"abc"' } })])
    const res = await createApiClient({ fetch: fn }).shipFeed.getFeed({ fresh: true, headers: { 'if-none-match': 'W/"abc"' } })
    expect(res.status).toBe(304)
    expect(res.etag).toBe('W/"abc"')
    expect(res.data).toBeNull()
    expect((calls[0].init as { cache?: string }).cache).toBe('no-cache')
  })

  it('marks the romance routes post-launch in the generated code and keeps the interest route out of that', () => {
    const generated = fs.readFileSync(path.join(ROOT, 'src/lib/api-client/generated.ts'), 'utf-8')
    expect(generated).toMatch(/Post-launch: answers 503 ROMANCE_PAUSED[\s\S]{0,200}getRomanceDrop/)
    expect(generated.match(/Post-launch: answers 503 ROMANCE_PAUSED/g)!.length).toBeGreaterThan(10)
    expect(Object.keys(OPERATIONS)).toContain('postRomanceInterest')
  })
})
