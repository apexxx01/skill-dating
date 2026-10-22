// Removing personal data from what is sent to Sentry. Pure, and written against plain objects (not the SDK's types) so the same functions serve the server, the edge and
// the browser and are tested without any of them. The SDK is told not to collect personal data in the first place (sendDefaultPii: false: no cookies, no IP address); this is
// the second line, for what gets in anyway: a URL with a query string, an exception message that quotes an e-mail address, a breadcrumb that logged a token.
//
// What is kept: the release, the environment, the stack, the route, the request id, our own user id (an opaque cuid, set by the application) and ids in the extra data.
// What goes: cookies, authorization and other headers, request bodies and query strings, IP addresses, e-mail addresses, phone numbers, bearer tokens, JWTs, long
// hex or base64 secrets, and the names of fields that look sensitive.

export const REDACTED = '[redacted]'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
// Keys of the services in use (Clerk, Resend, Stripe-style, GitHub, AWS) and any long run of hex or base64: what a secret looks like.
const KEY_LIKE = /\b(?:sk|pk|rk|re|whsec|ghp|gho|xox[abp])_[A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/g
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/g
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/** Free text with the things that identify a person or open an account removed. */
export function scrubText(value: string): string {
  return value.replace(EMAIL, REDACTED).replace(BEARER, '$1 ' + REDACTED).replace(JWT, REDACTED).replace(KEY_LIKE, REDACTED).replace(IPV4, REDACTED).replace(PHONE, REDACTED)
}

/** A URL without its query string or fragment (they carry tokens, search text and addresses), with the text scrubbed. */
export function scrubUrl(value: string): string {
  const cut = value.split(/[?#]/)[0]
  return scrubText(cut)
}

const SENSITIVE_KEY = /e-?mail|password|passwd|secret|token|authorization|cookie|phone|^ip$|ip_?address|address|session|signature|credential|dsn|api[-_]?key|birth|bio$|headline|message|content|body|text|name$|query|search|params/i

/** A URL or a path with a query string: the query is where tokens and search text travel. */
const URL_WITH_QUERY = /^(?:https?:\/\/|\/)[^\s]*[?#]/

const SAFE_HEADERS = new Set(['content-type', 'content-length', 'user-agent', 'accept', 'accept-language', 'x-request-id'])

type Bag = Record<string, unknown>

const isBag = (value: unknown): value is Bag => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Walks data, redacting what sits under a sensitive-looking name and scrubbing every string, to a bounded depth and size. */
export function scrubData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const text = value.length > 2000 ? value.slice(0, 2000) : value
    return URL_WITH_QUERY.test(text) ? scrubUrl(text) : scrubText(text)
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= 5) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubData(item, depth + 1))
  const out: Bag = {}
  for (const [key, inner] of Object.entries(value as Bag).slice(0, 100)) out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubData(inner, depth + 1)
  return out
}

function scrubRequest(request: Bag): Bag {
  const out: Bag = {}
  if (typeof request.url === 'string') out.url = scrubUrl(request.url)
  if (typeof request.method === 'string') out.method = request.method
  if (isBag(request.headers)) {
    const headers: Bag = {}
    for (const [name, header] of Object.entries(request.headers)) if (SAFE_HEADERS.has(name.toLowerCase()) && typeof header === 'string') headers[name] = scrubText(header)
    out.headers = headers
  }
  // Cookies, the query string, the body and the environment (which can hold the client's address) are never sent.
  return out
}

/** Our own id for the person, and nothing else about them. */
function scrubUser(user: Bag): Bag | undefined {
  return typeof user.id === 'string' || typeof user.id === 'number' ? { id: user.id } : undefined
}

/**
 * An event (an error, or a transaction) with personal data removed. Never throws: a scrubber that fails must not stop the event, nor let an unscrubbed one through, so
 * on failure it returns a minimal event with the message gone.
 */
export function scrubEvent<T extends Bag>(event: T): T {
  try {
    const out: Bag = { ...event }
    if (isBag(event.request)) out.request = scrubRequest(event.request)
    if (isBag(event.user)) {
      const user = scrubUser(event.user)
      if (user) out.user = user
      else delete out.user
    }
    if (typeof event.message === 'string') out.message = scrubText(event.message)
    if (isBag(event.exception) && Array.isArray(event.exception.values)) {
      out.exception = { ...event.exception, values: event.exception.values.map((entry: unknown) => (isBag(entry) && typeof entry.value === 'string' ? { ...entry, value: scrubText(entry.value) } : entry)) }
    }
    if (isBag(event.extra)) out.extra = scrubData(event.extra)
    if (isBag(event.contexts)) {
      // Contexts describe the runtime (os, browser, device): kept without free text.
      const { culture, ...rest } = event.contexts as Bag
      void culture
      out.contexts = rest
    }
    if (isBag(event.tags)) out.tags = scrubData(event.tags)
    if (Array.isArray(event.breadcrumbs)) out.breadcrumbs = event.breadcrumbs.map((crumb: unknown) => (isBag(crumb) ? scrubBreadcrumb(crumb) : crumb)).filter((crumb: unknown) => crumb !== null)
    if (typeof event.transaction === 'string') out.transaction = scrubUrl(event.transaction)
    if (Array.isArray(event.spans)) out.spans = event.spans.map((span: unknown) => (isBag(span) ? scrubSpan(span) : span))
    delete out.server_name
    return out as T
  } catch {
    // Only fields that cannot hold personal data, each read on its own (a field that threw once may throw again).
    const minimal: Bag = {}
    for (const key of ['event_id', 'release', 'environment', 'level', 'platform', 'timestamp', 'type']) {
      try {
        if (event[key] !== undefined) minimal[key] = event[key]
      } catch {
        // left out
      }
    }
    return { ...minimal, message: '[scrubbing failed]' } as unknown as T
  }
}

function scrubSpan(span: Bag): Bag {
  const out: Bag = { ...span }
  if (typeof span.description === 'string') out.description = scrubUrl(span.description)
  if (isBag(span.data)) out.data = scrubData(span.data)
  return out
}

/**
 * A breadcrumb with its URL stripped of the query and its data scrubbed, or null to drop it. Console breadcrumbs are dropped: they are free text from our own logs and from
 * libraries, and the structured logger already redacts what it writes (src/lib/log.ts), so what is left is not worth the risk.
 */
export function scrubBreadcrumb<T extends Bag>(crumb: T): T | null {
  try {
    if (crumb.category === 'console') return null
    const out: Bag = { ...crumb }
    if (typeof crumb.message === 'string') out.message = scrubText(crumb.message)
    if (isBag(crumb.data)) {
      const data: Bag = {}
      for (const [key, value] of Object.entries(crumb.data)) {
        if (/^(url|from|to)$/.test(key) && typeof value === 'string') data[key] = scrubUrl(value)
        else if (SENSITIVE_KEY.test(key)) data[key] = REDACTED
        else data[key] = scrubData(value, 3)
      }
      out.data = data
    }
    return out as T
  } catch {
    return null
  }
}
