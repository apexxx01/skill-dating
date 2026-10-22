// The Content-Security-Policy for pages (docs/SECURITY.md, "Headers"). Pure; src/middleware.ts builds one per request with a fresh nonce.
//
// Scripts: a nonce and 'strict-dynamic'. Next puts the nonce on its own scripts when it renders a page (it reads it from the request's CSP header that the
// middleware sets), and anything those scripts load (Clerk's sign-in code among them) is trusted through 'strict-dynamic'. The pages Next prerenders as
// static HTML (STATIC_PAGES, read from the build) cannot carry a per-request nonce, so for them scripts are allowed from this origin and inline instead,
// with every other directive just as tight. Moving those pages to dynamic rendering lets them use the nonce policy too (an open item in SECURITY.md).
//
// Everything else names exactly what the product loads: Clerk (its Frontend API, images and Cloudflare's bot check), Ably (realtime), the storage
// bucket (uploads go straight to it; post media and avatars are served from it), and, when error reporting is on, the Sentry host the browser sends reports to.

export const STATIC_PAGES = new Set(['/', '/error', '/onboarding', '/_not-found'])

const ABLY = ['https://*.ably.io', 'wss://*.ably.io', 'https://*.ably-realtime.com', 'wss://*.ably-realtime.com', 'https://*.ably.net', 'wss://*.ably.net']
const CLERK_STATIC = { images: 'https://img.clerk.com', challenges: 'https://challenges.cloudflare.com' }

/** The Clerk Frontend API host inside a publishable key (pk_test_ or pk_live_ followed by the base64 of "<host>$"), or null. */
export function clerkFrontendApi(publishableKey: string | undefined | null): string | null {
  const match = /^pk_(test|live)_(.+)$/.exec(publishableKey ?? '')
  if (!match) return null
  try {
    const decoded = atob(match[2]).replace(/\$$/, '')
    return /^[a-z0-9.-]+$/i.test(decoded) ? `https://${decoded}` : null
  } catch {
    return null
  }
}

export function originOf(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export interface CspInput {
  nonce: string
  /** The page is prerendered as static HTML (no nonce on its scripts). */
  staticPage: boolean
  clerkFrontendApi: string | null
  /** The bucket's origins: its public base URL and its endpoint (presigned uploads, signed reads). */
  storageOrigins: string[]
  /** Where the browser may send error reports (the Sentry host in the DSN), if reporting is on. */
  reportingOrigins?: string[]
  development: boolean
}

export function pageCsp(input: CspInput): string {
  const clerk = input.clerkFrontendApi ? [input.clerkFrontendApi] : []
  const storage = [...new Set(input.storageOrigins)]
  const reporting = [...new Set(input.reportingOrigins ?? [])]
  const scripts = input.staticPage
    ? ["'self'", "'unsafe-inline'", ...clerk, CLERK_STATIC.challenges]
    : ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'", ...clerk, CLERK_STATIC.challenges]
  if (input.development) scripts.push("'unsafe-eval'")
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', scripts],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', CLERK_STATIC.images, ...storage]],
    ['media-src', ["'self'", 'blob:', ...storage]],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", ...clerk, ...ABLY, ...storage, ...reporting, ...(input.development ? ['ws:'] : [])]],
    ['frame-src', [...clerk, CLERK_STATIC.challenges]],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ]
  const policy = directives.filter(([, values]) => values.length > 0).map(([name, values]) => `${name} ${values.join(' ')}`)
  if (!input.development) policy.push('upgrade-insecure-requests')
  return policy.join('; ')
}

/** A fresh nonce: 16 random bytes, base64. Works on the Edge runtime and in Node. */
export function newNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}
