import { describe, it, expect } from 'vitest'
import { awsEncode, encodeKeyPath, presignUrl } from './sigv4'

describe('presignUrl', () => {
  it('reproduces the example in the AWS documentation (presigned GET of test.txt)', () => {
    const url = presignUrl({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    )
  })

  it('signs extra headers with the URL, so a different value does not verify', () => {
    const base = { method: 'PUT' as const, host: 'h.example.com', path: '/b/k.png', region: 'auto', accessKeyId: 'id', secretAccessKey: 'secret', expiresSeconds: 600, now: new Date('2026-10-18T10:00:00Z') }
    const png = presignUrl({ ...base, headers: { 'content-type': 'image/png' } })
    const jpeg = presignUrl({ ...base, headers: { 'content-type': 'image/jpeg' } })
    expect(png).toContain('X-Amz-SignedHeaders=content-type%3Bhost')
    expect(png.split('X-Amz-Signature=')[1]).not.toBe(jpeg.split('X-Amz-Signature=')[1])
  })

  it('differs by method, key and time, and is deterministic', () => {
    const base = { method: 'GET' as const, host: 'h.example.com', path: '/b/k.png', region: 'auto', accessKeyId: 'id', secretAccessKey: 'secret', expiresSeconds: 600, now: new Date('2026-10-18T10:00:00Z') }
    const sig = (over: object) => presignUrl({ ...base, ...over }).split('X-Amz-Signature=')[1]
    expect(sig({})).toBe(sig({}))
    expect(sig({ method: 'HEAD' })).not.toBe(sig({}))
    expect(sig({ path: '/b/other.png' })).not.toBe(sig({}))
    expect(sig({ now: new Date('2026-10-18T10:00:01Z') })).not.toBe(sig({}))
  })

  it('refuses a lifetime outside what S3 allows', () => {
    const base = { method: 'GET' as const, host: 'h', path: '/', region: 'r', accessKeyId: 'i', secretAccessKey: 's', now: new Date() }
    expect(() => presignUrl({ ...base, expiresSeconds: 0 })).toThrow()
    expect(() => presignUrl({ ...base, expiresSeconds: 604_801 })).toThrow()
    expect(() => presignUrl({ ...base, expiresSeconds: 604_800 })).not.toThrow()
  })
})

describe('encoding', () => {
  it('keeps the unreserved characters and encodes the rest the way AWS does', () => {
    expect(awsEncode("a-b_c.d~e")).toBe('a-b_c.d~e')
    expect(awsEncode("a b/c!'()*")).toBe('a%20b%2Fc%21%27%28%29%2A')
    expect(encodeKeyPath('posts/u 1/a+b.png')).toBe('posts/u%201/a%2Bb.png')
  })
})
