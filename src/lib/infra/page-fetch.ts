import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { LookupFunction } from 'node:net'
import { env } from '@/lib/env'

// Fetching a public web page that a USER named (an external hackathon's link), safely. The server must never be turned into a way to reach what only
// it can reach, so:
//  - only http and https, only ports 80 and 443, no credentials in the URL;
//  - every address the host resolves to is checked AT CONNECT TIME (a custom DNS lookup on the socket), so a name that resolves to a private,
//    loopback, link-local or otherwise special address is refused, and a name cannot pass a check and then be re-resolved somewhere else;
//  - redirects are followed by hand, at most three, and only on the same host (a "www." difference allowed);
//  - a short timeout for the whole fetch, a size cap on what is read, and only HTML is accepted.
// The page is only ever read as text (src/lib/squads/external.ts parses it); nothing in it is executed or stored as it is.
//
// `PageFetcher` is the adapter: routes depend on it, tests and a local page can use their own.

export interface FetchedPage {
  url: string
  status: number
  contentType: string
  html: string
  /** The body was longer than the cap and was cut. */
  truncated: boolean
}

export type FetchRefusal = 'invalid-url' | 'scheme' | 'port' | 'credentials' | 'private-address' | 'dns' | 'redirect-off-host' | 'too-many-redirects' | 'timeout' | 'not-html' | 'http-error' | 'network'

export class PageFetchError extends Error {
  constructor(readonly reason: FetchRefusal, message: string = reason) {
    super(message)
    this.name = 'PageFetchError'
  }
}

export interface PageFetcher {
  fetchPage(url: string): Promise<FetchedPage>
}

export const PAGE_FETCH_LIMITS = { timeoutMs: 5000, maxBytes: 1_000_000, maxRedirects: 3 }

// --- Addresses --------------------------------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let address = ip.toLowerCase().split('%')[0]
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = ipv4ToInt(v4[1])
    address = address.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = address.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 && missing !== 0) return null
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail].map((group) => parseInt(group, 16))
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null
}

/**
 * Whether an address must never be fetched: private, loopback, link-local, carrier-grade NAT, documentation, multicast, reserved, unspecified, and
 * the IPv6 forms of all of them (including an IPv4 address mapped into IPv6). Anything that does not parse is treated as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return PRIVATE_V4.some(([base, bits]) => inV4Range(ip, base, bits)) || ip === '255.255.255.255'
  if (family !== 6) return true
  const groups = ipv6Groups(ip)
  if (!groups) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  const embeddedV4 = () => `${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`
  if (groups.every((group) => group === 0)) return true // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return isPrivateAddress(embeddedV4()) // ::ffff:a.b.c.d, ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateAddress(embeddedV4()) // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true // documentation
  if (g0 === 0x2001 && g1 < 0x0200) return true // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ...)
  if (g0 === 0x2002) return isPrivateAddress(`${g1 >>> 8}.${g1 & 0xff}.${g2 >>> 8}.${g2 & 0xff}`) // 6to4
  return false
}

// --- URLs -------------------------------------------------------------------------------------------------------

const hostKey = (host: string) => host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')

function allowedPrivate(): Set<string> {
  return new Set((env.PAGE_FETCH_ALLOW_PRIVATE ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
}

/** Checks a URL before anything is sent. Throws PageFetchError. */
export function checkUrl(raw: string, allow: ReadonlySet<string> = allowedPrivate()): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PageFetchError('invalid-url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PageFetchError('scheme')
  if (url.username || url.password) throw new PageFetchError('credentials')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (port !== '80' && port !== '443' && !allow.has(`${url.hostname.toLowerCase()}:${port}`)) throw new PageFetchError('port')
  // A literal private address is refused before any connection is made.
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(literal) && isPrivateAddress(literal) && !allow.has(`${url.hostname.toLowerCase()}:${port}`)) throw new PageFetchError('private-address')
  return url
}

/** A DNS lookup for the socket that refuses (with an error the request reports) any host that resolves to a private address. */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]
      if (list.length === 0) return callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 0)
      if (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
        return callback(Object.assign(new Error('private address'), { code: 'EPRIVATE' }), '', 0)
      }
      const chosen = list[0]
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
      return callback(null, chosen.address, chosen.family)
    })
  }
}

// --- The fetcher --------------------------------------------------------------------------------------------------

function requestOnce(url: URL, deadline: number, maxBytes: number, allow: ReadonlySet<string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; truncated: boolean }> {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const allowPrivate = allow.has(`${url.hostname.toLowerCase()}:${port}`)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new PageFetchError('timeout'))
    const request = client.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(allowPrivate),
        headers: { 'User-Agent': 'SkillDatingBot/1.0 (+hackathon link preview)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
        timeout: remaining,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        response.on('data', (chunk: Buffer) => {
          if (truncated) return
          size += chunk.length
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)))
            truncated = true
            response.destroy()
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), truncated })
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), truncated }))
        response.on('error', (error) => (truncated ? undefined : reject(new PageFetchError('network', error.message))))
      }
    )
    request.on('timeout', () => request.destroy(new PageFetchError('timeout')))
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof PageFetchError) return reject(error)
      if (error.code === 'EPRIVATE') return reject(new PageFetchError('private-address'))
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return reject(new PageFetchError('dns'))
      reject(new PageFetchError('network', error.message))
    })
    request.end()
  })
}

export class SafePageFetcher implements PageFetcher {
  constructor(
    private readonly limits = PAGE_FETCH_LIMITS,
    private readonly allow: ReadonlySet<string> = allowedPrivate()
  ) {}

  async fetchPage(raw: string): Promise<FetchedPage> {
    const deadline = Date.now() + this.limits.timeoutMs
    let url = checkUrl(raw, this.allow)
    const host = hostKey(url.hostname)
    for (let redirects = 0; ; redirects++) {
      const response = await requestOnce(url, deadline, this.limits.maxBytes, this.allow)
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        if (redirects >= this.limits.maxRedirects) throw new PageFetchError('too-many-redirects')
        const next = checkUrl(new URL(response.headers.location, url).toString(), this.allow)
        if (hostKey(next.hostname) !== host) throw new PageFetchError('redirect-off-host')
        url = next
        continue
      }
      if (response.status < 200 || response.status >= 300) throw new PageFetchError('http-error', `status ${response.status}`)
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new PageFetchError('not-html')
      return { url: url.toString(), status: response.status, contentType, html: response.body, truncated: response.truncated }
    }
  }
}

const globalForFetch = globalThis as unknown as { __pageFetcher?: PageFetcher }

export function getPageFetcher(): PageFetcher {
  if (!globalForFetch.__pageFetcher) globalForFetch.__pageFetcher = new SafePageFetcher()
  return globalForFetch.__pageFetcher
}

/** Replaces the process-wide fetcher (tests). */
export function setPageFetcher(fetcher: PageFetcher | undefined) {
  globalForFetch.__pageFetcher = fetcher
}
