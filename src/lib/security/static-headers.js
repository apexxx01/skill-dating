// The security headers sent on every response (docs/SECURITY.md, "Headers"). Plain CommonJS so next.config.js can require it; the unit test
// (src/lib/security/csp.test.ts) and the integration test (tests/integration/security-headers.test.ts) read the same list. Pages get their
// Content-Security-Policy from src/middleware.ts (it needs a nonce per request); API responses get API_CSP from next.config.js.

const SECURITY_HEADERS = [
  // Two years, subdomains included, ready for the preload list. Browsers ignore it over plain http (local development).
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing on the platform uses these; a script that tries is refused.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
  // frame-ancestors 'none' in the CSP says the same to modern browsers; this is for the ones that only read the old header.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

// An API answer is data, never a document to render: nothing may load from it, and nothing may frame it.
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

module.exports = { SECURITY_HEADERS, API_CSP }
