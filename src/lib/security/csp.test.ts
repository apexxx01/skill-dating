import { describe, it, expect } from 'vitest'
import { clerkFrontendApi, newNonce, originOf, pageCsp, STATIC_PAGES } from './csp'
const { SECURITY_HEADERS, API_CSP } = require('./static-headers.js') as { SECURITY_HEADERS: { key: string; value: string }[]; API_CSP: string }

const fapi = 'https://clever-cat-12.clerk.accounts.dev'
const base = { nonce: 'abc123', staticPage: false, clerkFrontendApi: fapi, storageOrigins: ['https://cdn.example.com'], development: false }
const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''

describe('pageCsp', () => {
  it('uses a nonce and strict-dynamic for scripts on dynamic pages, with no unsafe-inline or unsafe-eval', () => {
    const policy = pageCsp(base)
    const scripts = directive(policy, 'script-src')
    expect(scripts).toContain("'nonce-abc123'")
    expect(scripts).toContain("'strict-dynamic'")
    expect(scripts).not.toContain('unsafe-inline')
    expect(scripts).not.toContain('unsafe-eval')
  })

  it('forbids framing, plugins and foreign forms, and upgrades insecure requests', () => {
    const policy = pageCsp(base)
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive(policy, 'object-src')).toBe("object-src 'none'")
    expect(directive(policy, 'form-action')).toBe("form-action 'self'")
    expect(policy).toContain('upgrade-insecure-requests')
  })

  it('allows Clerk, Ably and the storage CDN and nothing else from outside', () => {
    const policy = pageCsp(base)
    expect(directive(policy, 'connect-src')).toContain(fapi)
    expect(directive(policy, 'connect-src')).toContain('wss://*.ably.io')
    expect(directive(policy, 'img-src')).toContain('https://cdn.example.com')
    expect(directive(policy, 'img-src')).toContain('https://img.clerk.com')
    expect(directive(policy, 'frame-src')).toContain('https://challenges.cloudflare.com')
    expect(directive(policy, 'default-src')).toBe("default-src 'self'")
  })

  it('lets the browser send error reports to the Sentry host when reporting is on, and only then', () => {
    expect(directive(pageCsp(base), 'connect-src')).not.toContain('sentry')
    const policy = pageCsp({ ...base, reportingOrigins: ['https://o1.ingest.sentry.io'] })
    expect(directive(policy, 'connect-src')).toContain('https://o1.ingest.sentry.io')
    expect(directive(policy, 'script-src')).not.toContain('sentry')
  })

  it('lets prerendered pages run their inline scripts without a nonce, and nothing else changes', () => {
    const policy = pageCsp({ ...base, staticPage: true })
    expect(directive(policy, 'script-src')).toContain("'unsafe-inline'")
    expect(directive(policy, 'script-src')).not.toContain('nonce-')
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'")
    expect([...STATIC_PAGES]).toEqual(['/', '/error', '/onboarding', '/_not-found'])
  })

  it('relaxes only what development needs', () => {
    const policy = pageCsp({ ...base, development: true })
    expect(directive(policy, 'script-src')).toContain("'unsafe-eval'")
    expect(policy).not.toContain('upgrade-insecure-requests')
  })
})

describe('helpers', () => {
  it('reads the Clerk Frontend API host from a publishable key', () => {
    expect(clerkFrontendApi(`pk_test_${btoa('clever-cat-12.clerk.accounts.dev$')}`)).toBe(fapi)
    expect(clerkFrontendApi('pk_test_unit')).toBeNull()
    expect(clerkFrontendApi(undefined)).toBeNull()
  })

  it('makes a fresh nonce every time', () => {
    expect(newNonce()).not.toBe(newNonce())
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  })

  it('reads origins', () => {
    expect(originOf('https://bucket.example.com/a/b')).toBe('https://bucket.example.com')
    expect(originOf('nope')).toBeNull()
  })
})

describe('static headers', () => {
  it('sends HSTS, nosniff, a strict referrer policy, a permissions policy and no framing', () => {
    const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]))
    expect(byKey['Strict-Transport-Security']).toMatch(/max-age=\d{8}; includeSubDomains/)
    expect(byKey['X-Content-Type-Options']).toBe('nosniff')
    expect(byKey['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(byKey['Permissions-Policy']).toContain('camera=()')
    expect(byKey['X-Frame-Options']).toBe('DENY')
    expect(API_CSP).toContain("default-src 'none'")
    expect(API_CSP).toContain("frame-ancestors 'none'")
  })
})
