// External hackathons: most hackathons live on Devfolio, Devpost, MLH, Unstop or Luma, and this platform is the team layer on top of them. A trusted
// user submits a link; the server fetches the public page (src/lib/infra/page-fetch.ts, with the SSRF rules) and reads what it says about itself
// from its OpenGraph tags and JSON-LD. Pure: these functions read a URL or a string of HTML and never execute or keep anything from the page but
// the sanitised text fields below.

/** The platforms a hackathon is known to live on (the HackathonPlatform enum). */
export type HackathonPlatform = 'DEVFOLIO' | 'DEVPOST' | 'MLH' | 'UNSTOP' | 'LUMA' | 'OTHER'
export type HackathonMode = 'ONLINE' | 'IN_PERSON' | 'HYBRID'

const TRACKING_PARAMS = /^(utm_[a-z]+|ref|ref_src|source|fbclid|gclid|mc_cid|mc_eid|igshid|si)$/i

/**
 * The one spelling of a hackathon link that duplicates are found by: https, the host in lower case without "www.", no default port, no fragment,
 * no tracking parameters, the rest sorted, and no trailing slash. Null for anything that is not an http(s) URL, or that carries credentials.
 */
export function normalizeExternalUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  if (!host) return null
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : ''
  const params = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key)).sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ''
  const path = url.pathname.replace(/\/+$/, '') || ''
  return `https://${host}${port}${path}${query}`
}

const PLATFORM_HOSTS: [HackathonPlatform, string[]][] = [
  ['DEVFOLIO', ['devfolio.co']],
  ['DEVPOST', ['devpost.com']],
  ['MLH', ['mlh.io', 'mlh.com']],
  ['UNSTOP', ['unstop.com', 'dare2compete.com']],
  ['LUMA', ['lu.ma', 'luma.com']],
]

/** The platform a link is on, by its host or a subdomain of it (ethindia.devfolio.co is Devfolio). */
export function platformOf(urlOrHost: string): HackathonPlatform {
  let host = urlOrHost.toLowerCase()
  try {
    host = new URL(urlOrHost).hostname.toLowerCase()
  } catch {
    // already a host
  }
  host = host.replace(/^www\./, '')
  for (const [platform, hosts] of PLATFORM_HOSTS) if (hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return platform
  return 'OTHER'
}

// --- Text -------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Plain text from a page: no tags, no control characters, entities decoded, whitespace collapsed, at most `max` characters. */
export function sanitizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = decodeEntities(value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

// --- Page metadata ----------------------------------------------------------------------------------------------

export interface PageMetadata {
  name: string | null
  description: string | null
  image: string | null
  startDate: Date | null
  endDate: Date | null
  mode: HackathonMode | null
  city: string | null
  country: string | null
}

export const METADATA_LIMITS = { name: 200, description: 5000, place: 100 }

function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
  return out
}

function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>()
  // Quote-aware, so a ">" inside an attribute value does not end the tag.
  for (const match of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = attributesOf(match[0])
    const key = (attributes.property ?? attributes.name ?? attributes.itemprop ?? '').toLowerCase()
    if (key && attributes.content !== undefined && !out.has(key)) out.set(key, attributes.content)
  }
  return out
}

/** The JSON-LD objects on a page, flattened out of arrays and @graph. Parsed as data only: a block that is not valid JSON is skipped. */
export function jsonLdObjects(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      out.push(value as Record<string, unknown>)
      const graph = (value as Record<string, unknown>)['@graph']
      if (graph) visit(graph)
    }
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1]))
    } catch {
      // not data we can read
    }
  }
  return out
}

const EVENT_TYPES = new Set(['event', 'hackathon', 'educationevent', 'socialevent', 'businessevent', 'exhibitionevent'])
const typesOf = (object: Record<string, unknown>) => [object['@type']].flat().filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase())

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getUTCFullYear()
  return year >= 2000 && year <= 2100 ? date : null
}

function absoluteHttpUrl(value: unknown, base: string): string | null {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' ? ((value as Record<string, unknown>).url as string | undefined) : undefined
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const url = new URL(raw.trim(), base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().slice(0, 2000) : null
  } catch {
    return null
  }
}

function modeOf(event: Record<string, unknown>): HackathonMode | null {
  const attendance = typeof event.eventAttendanceMode === 'string' ? event.eventAttendanceMode.toLowerCase() : ''
  if (attendance.includes('mixed')) return 'HYBRID'
  if (attendance.includes('online')) return 'ONLINE'
  if (attendance.includes('offline')) return 'IN_PERSON'
  const locations = [event.location].flat().filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object')
  const virtual = locations.some((l) => typesOf(l).includes('virtuallocation'))
  const physical = locations.some((l) => typesOf(l).includes('place'))
  if (virtual && physical) return 'HYBRID'
  if (virtual) return 'ONLINE'
  if (physical) return 'IN_PERSON'
  return null
}

function placeOf(event: Record<string, unknown>): { city: string | null; country: string | null } {
  for (const location of [event.location].flat()) {
    if (!location || typeof location !== 'object' || !typesOf(location as Record<string, unknown>).includes('place')) continue
    const address = (location as Record<string, unknown>).address
    if (address && typeof address === 'object') {
      const a = address as Record<string, unknown>
      const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry && typeof a.addressCountry === 'object' ? (a.addressCountry as Record<string, unknown>).name : null
      return { city: sanitizeText(a.addressLocality, METADATA_LIMITS.place), country: sanitizeText(country, METADATA_LIMITS.place) }
    }
  }
  return { city: null, country: null }
}

/**
 * What a hackathon's public page says about itself: a JSON-LD Event (or Hackathon) first, then OpenGraph and Twitter tags, then the <title>. Every
 * text is sanitised to plain text and capped; the image must be an http(s) URL. Nothing else from the page is kept.
 */
export function parseHackathonPage(html: string, pageUrl: string): PageMetadata {
  const event = jsonLdObjects(html).find((object) => typesOf(object).some((t) => EVENT_TYPES.has(t)))
  const meta = metaTags(html)
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const place = event ? placeOf(event) : { city: null, country: null }
  return {
    name: sanitizeText(event?.name, METADATA_LIMITS.name) ?? sanitizeText(meta.get('og:title'), METADATA_LIMITS.name) ?? sanitizeText(meta.get('twitter:title'), METADATA_LIMITS.name) ?? sanitizeText(title, METADATA_LIMITS.name),
    description:
      sanitizeText(event?.description, METADATA_LIMITS.description) ?? sanitizeText(meta.get('og:description'), METADATA_LIMITS.description) ?? sanitizeText(meta.get('description'), METADATA_LIMITS.description) ?? sanitizeText(meta.get('twitter:description'), METADATA_LIMITS.description),
    image: absoluteHttpUrl(event?.image, pageUrl) ?? absoluteHttpUrl(meta.get('og:image'), pageUrl) ?? absoluteHttpUrl(meta.get('twitter:image'), pageUrl),
    startDate: dateOf(event?.startDate) ?? dateOf(meta.get('event:start_time')),
    endDate: dateOf(event?.endDate) ?? dateOf(meta.get('event:end_time')),
    mode: event ? modeOf(event) : null,
    ...place,
  }
}

/** The status a hackathon has by its dates. */
export function statusByDates(startDate: Date, endDate: Date, now: Date): 'UPCOMING' | 'ACTIVE' | 'ENDED' {
  if (now.getTime() < startDate.getTime()) return 'UPCOMING'
  if (now.getTime() <= endDate.getTime()) return 'ACTIVE'
  return 'ENDED'
}
