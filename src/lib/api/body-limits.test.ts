import { describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

vi.mock('@/lib/prisma', () => ({ prisma: {}, default: {} }))

import { readBodyText, validateBody } from './handler'
import { MAX_BODY_BYTES, boundedJson, boundedRecord } from './limits'

const post = (body: string, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/things', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

describe('readBodyText', () => {
  it('returns the body when it is within the limit', async () => {
    expect(await readBodyText(post('{"a":1}'))).toBe('{"a":1}')
  })

  it('refuses a body that declares more than the limit, before reading it', async () => {
    const res = await readBodyText(post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }))
    expect(res).toBeInstanceOf(NextResponse)
    expect((res as NextResponse).status).toBe(413)
  })

  it('refuses a body that is bigger than the limit whatever it declares', async () => {
    const res = await readBodyText(post(JSON.stringify({ text: 'x'.repeat(2000) })), 1000)
    expect((res as NextResponse).status).toBe(413)
    expect(await (res as NextResponse).json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
  })
})

describe('validateBody', () => {
  const schema = z.object({ name: z.string().max(10) })

  it('parses a valid body', async () => {
    expect(await validateBody(schema)(post('{"name":"ada"}'))).toEqual({ data: { name: 'ada' } })
  })

  it('refuses a body over the limit with 413, broken JSON with 400 INVALID_JSON, and a bad shape with 400 VALIDATION_FAILED', async () => {
    const big = (await validateBody(schema)(post(JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) })))) as NextResponse
    expect(big.status).toBe(413)
    const broken = (await validateBody(schema)(post('{nope'))) as NextResponse
    expect((await broken.json()).error.code).toBe('INVALID_JSON')
    const wrong = (await validateBody(schema)(post('{"name":"far too long a name"}'))) as NextResponse
    expect((await wrong.json()).error.code).toBe('VALIDATION_FAILED')
  })
})

describe('bounded records', () => {
  it('caps the number of keys and their length', () => {
    const schema = boundedRecord(z.string().max(5), { maxKeys: 2 })
    expect(schema.safeParse({ a: 'x', b: 'y' }).success).toBe(true)
    expect(schema.safeParse({ a: 'x', b: 'y', c: 'z' }).success).toBe(false)
    expect(schema.safeParse({ ['k'.repeat(65)]: 'x' }).success).toBe(false)
  })

  it('caps free-form JSON by its serialised size', () => {
    expect(boundedJson(50).safeParse({ a: 'short' }).success).toBe(true)
    expect(boundedJson(50).safeParse({ a: 'x'.repeat(60) }).success).toBe(false)
  })
})
