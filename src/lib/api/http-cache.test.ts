import { describe, it, expect } from 'vitest'
import { NextResponse } from 'next/server'
import { applyHttpCache, cacheControlOf, etagOf, matchesEtag } from './http-cache'

const get = (headers: Record<string, string> = {}) => new Request('http://localhost/api/x', { method: 'GET', headers })
const answer = (body: unknown = { items: [1, 2, 3] }, init?: ResponseInit) => NextResponse.json(body, init)

describe('HTTP caching of read-heavy answers', () => {
  it('makes the same tag for the same body and another for another', () => {
    expect(etagOf('a')).toBe(etagOf('a'))
    expect(etagOf('a')).not.toBe(etagOf('b'))
    expect(etagOf('a')).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/)
  })

  it('says private, with the max-age, and asks to be revalidated when the max-age is zero', () => {
    expect(cacheControlOf({ maxAge: 30 })).toBe('private, max-age=30')
    expect(cacheControlOf({ maxAge: 0 })).toBe('private, max-age=0, must-revalidate')
  })

  it('adds the headers to a 200 and leaves the body as it was', async () => {
    const response = await applyHttpCache(get(), answer(), { maxAge: 15 })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, max-age=15')
    expect(response.headers.get('etag')).toMatch(/^W\//)
    expect(response.headers.get('vary')).toMatch(/Authorization/)
    expect(await response.json()).toEqual({ items: [1, 2, 3] })
  })

  it('answers 304 with no body when the client has the answer, and the full body when it does not (also when it revalidates with no-cache: that is what a conditional fetch sends)', async () => {
    const first = await applyHttpCache(get(), answer(), { maxAge: 15 })
    const tag = first.headers.get('etag')!
    const same = await applyHttpCache(get({ 'if-none-match': tag }), answer(), { maxAge: 15 })
    expect(same.status).toBe(304)
    expect(await same.text()).toBe('')
    expect(same.headers.get('etag')).toBe(tag)
    expect(same.headers.get('cache-control')).toBe('private, max-age=15')

    const changed = await applyHttpCache(get({ 'if-none-match': tag }), answer({ items: [9] }), { maxAge: 15 })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ items: [9] })

    const revalidated = await applyHttpCache(get({ 'if-none-match': tag, 'cache-control': 'no-cache' }), answer(), { maxAge: 15 })
    expect(revalidated.status).toBe(304)
    const revalidatedAfterAWrite = await applyHttpCache(get({ 'if-none-match': tag, 'cache-control': 'no-cache' }), answer({ items: [1, 2, 3, 4] }), { maxAge: 15 })
    expect(revalidatedAfterAWrite.status).toBe(200)
  })

  it('compares tags weakly and understands a list and *', () => {
    const tag = etagOf('x')
    expect(matchesEtag(tag, tag)).toBe(true)
    expect(matchesEtag(tag.replace(/^W\//, ''), tag)).toBe(true)
    expect(matchesEtag(`"other", ${tag}`, tag)).toBe(true)
    expect(matchesEtag('*', tag)).toBe(true)
    expect(matchesEtag('"other"', tag)).toBe(false)
    expect(matchesEtag(null, tag)).toBe(false)
  })

  it('touches nothing that is not a successful GET, and nothing that set its own Cache-Control', async () => {
    const post = await applyHttpCache(new Request('http://localhost/api/x', { method: 'POST' }), answer(), { maxAge: 15 })
    expect(post.headers.get('etag')).toBeNull()
    const failure = await applyHttpCache(get(), answer({ error: { code: 'X' } }, { status: 404 }), { maxAge: 15 })
    expect(failure.status).toBe(404)
    expect(failure.headers.get('etag')).toBeNull()
    const own = NextResponse.json({ a: 1 }, { headers: { 'Cache-Control': 'no-store' } })
    const kept = await applyHttpCache(get(), own, { maxAge: 15 })
    expect(kept.headers.get('cache-control')).toBe('no-store')
    expect(kept.headers.get('etag')).toBeNull()
  })

  it('keeps the other headers of the answer (a next-page cursor, the request id)', async () => {
    const response = await applyHttpCache(get(), answer({ a: 1 }, { headers: { 'X-Next-Cursor': 'abc' } }), { maxAge: 5 })
    expect(response.headers.get('x-next-cursor')).toBe('abc')
  })
})
