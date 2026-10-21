import { describe, it, expect } from 'vitest'
import { INTEGRATION_BASE_URL } from './config'
import { syntheticIp } from './helpers'
const { SECURITY_HEADERS, API_CSP } = require('../../src/lib/security/static-headers.js') as { SECURITY_HEADERS: { key: string; value: string }[]; API_CSP: string }

// The security headers, as the running server sends them (docs/SECURITY.md, "Headers").
const get = (path: string) => fetch(INTEGRATION_BASE_URL + path, { redirect: 'manual', headers: { 'x-forwarded-for': syntheticIp() } })

describe('security headers', () => {
  it('sends the static headers and the API policy on API responses', async () => {
    const res = await get('/api/health')
    for (const { key, value } of SECURITY_HEADERS) expect(res.headers.get(key), key).toBe(value)
    expect(res.headers.get('content-security-policy')).toBe(API_CSP)
  })

  it('puts a fresh nonce in the policy of a dynamic page, and on its scripts', async () => {
    const first = await get('/signin')
    const second = await get('/signin')
    const policy = first.headers.get('content-security-policy') ?? ''
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1]
    expect(nonce).toBeTruthy()
    expect(policy).toContain("'strict-dynamic'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(second.headers.get('content-security-policy')).not.toBe(policy)
    const html = await first.text()
    expect(html).toContain(`nonce="${nonce}"`)
    for (const { key, value } of SECURITY_HEADERS) expect(first.headers.get(key), key).toBe(value)
  })

  it('gives a prerendered page the policy without a nonce, as tight everywhere else', async () => {
    const policy = (await get('/')).headers.get('content-security-policy') ?? ''
    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toContain('nonce-')
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
  })

  it('keeps the policy on a redirect', async () => {
    const res = await get('/dashboard')
    expect([302, 307, 308]).toContain(res.status)
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })
})
