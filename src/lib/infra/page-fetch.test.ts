import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkUrl, isPrivateAddress, PageFetchError, SafePageFetcher } from './page-fetch'

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '2002:7f00:0001::1', // 6to4 of 127.0.0.1
    '2001:db8::1',
    'not-an-ip',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
})

describe('checkUrl', () => {
  const refusal = (url: string) => {
    try {
      checkUrl(url, new Set())
      return null
    } catch (error) {
      return (error as PageFetchError).reason
    }
  }

  it('refuses other schemes, other ports, credentials and literal private addresses', () => {
    expect(refusal('file:///etc/passwd')).toBe('scheme')
    expect(refusal('gopher://example.com')).toBe('scheme')
    expect(refusal('https://example.com:8080/')).toBe('port')
    expect(refusal('https://a:b@example.com/')).toBe('credentials')
    expect(refusal('http://127.0.0.1/')).toBe('private-address')
    expect(refusal('http://[::1]/')).toBe('private-address')
    expect(refusal('http://169.254.169.254/latest/meta-data')).toBe('private-address')
    expect(refusal('nonsense')).toBe('invalid-url')
    expect(refusal('https://example.com/a')).toBeNull()
  })
})

describe('SafePageFetcher', () => {
  let server: http.Server
  let base: string
  let allow: Set<string>

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const path = request.url ?? '/'
      if (path === '/page') return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>Hello</title>')
      if (path === '/hop') return response.writeHead(302, { Location: '/page' }).end()
      if (path === '/away') return response.writeHead(302, { Location: 'https://example.com/' }).end()
      if (path === '/loop') return response.writeHead(302, { Location: '/loop' }).end()
      if (path === '/json') return response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      if (path === '/big') return response.writeHead(200, { 'Content-Type': 'text/html' }).end('x'.repeat(5000))
      if (path === '/slow') return setTimeout(() => response.writeHead(200, { 'Content-Type': 'text/html' }).end('late'), 1500)
      if (path === '/missing') return response.writeHead(404, { 'Content-Type': 'text/html' }).end('no')
      response.writeHead(500).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://localhost:${port}`
    allow = new Set([`localhost:${port}`])
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const fetcher = (over: Partial<{ timeoutMs: number; maxBytes: number; maxRedirects: number }> = {}) => new SafePageFetcher({ timeoutMs: 1000, maxBytes: 1000, maxRedirects: 3, ...over }, allow)
  const reason = async (promise: Promise<unknown>) => {
    try {
      await promise
      return null
    } catch (error) {
      return (error as PageFetchError).reason
    }
  }

  it('fetches an HTML page and follows a same-host redirect', async () => {
    expect((await fetcher().fetchPage(`${base}/page`)).html).toBe('<title>Hello</title>')
    const hopped = await fetcher().fetchPage(`${base}/hop`)
    expect(hopped.url).toBe(`${base}/page`)
  })

  it('refuses a redirect to another host, too many redirects, a non-HTML answer and an error status', async () => {
    expect(await reason(fetcher().fetchPage(`${base}/away`))).toBe('redirect-off-host')
    expect(await reason(fetcher().fetchPage(`${base}/loop`))).toBe('too-many-redirects')
    expect(await reason(fetcher().fetchPage(`${base}/json`))).toBe('not-html')
    expect(await reason(fetcher().fetchPage(`${base}/missing`))).toBe('http-error')
  })

  it('cuts a body at the size cap and gives up after the timeout', async () => {
    const big = await fetcher({ maxBytes: 100 }).fetchPage(`${base}/big`)
    expect(big.html).toHaveLength(100)
    expect(big.truncated).toBe(true)
    expect(await reason(fetcher({ timeoutMs: 300 }).fetchPage(`${base}/slow`))).toBe('timeout')
  })

  it('refuses a name that resolves to a loopback address unless it is explicitly allowed', async () => {
    const port = new URL(base).port
    const strict = new SafePageFetcher({ timeoutMs: 1000, maxBytes: 1000, maxRedirects: 3 }, new Set([`other:${port}`]))
    // The port is allowed for another name only, so the port check passes nothing: refused before connecting.
    expect(await reason(strict.fetchPage(`${base}/page`))).toBe('port')
    // On an ordinary port the DNS guard is what refuses it.
    expect(await reason(new SafePageFetcher(undefined, new Set()).fetchPage('http://localhost/page'))).toBe('private-address')
  })
})
