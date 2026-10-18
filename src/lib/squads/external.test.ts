import { describe, it, expect } from 'vitest'
import { jsonLdObjects, normalizeExternalUrl, parseHackathonPage, platformOf, sanitizeText, statusByDates } from './external'

describe('normalizeExternalUrl', () => {
  it('gives one spelling for the same page', () => {
    const same = [
      'https://ethindia.devfolio.co/',
      'http://ethindia.devfolio.co',
      'https://ETHIndia.Devfolio.co:443/?utm_source=twitter&utm_medium=social#prizes',
      'https://www.ethindia.devfolio.co/?ref=abc',
    ]
    for (const url of same) expect(normalizeExternalUrl(url)).toBe('https://ethindia.devfolio.co')
  })

  it('keeps the path and the parameters that matter, sorted', () => {
    expect(normalizeExternalUrl('https://devpost.com/hackathons/abc/?b=2&a=1&fbclid=x')).toBe('https://devpost.com/hackathons/abc?a=1&b=2')
    expect(normalizeExternalUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x')
  })

  it('refuses anything that is not a plain http(s) link', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', 'not a url', 'data:text/html,hi']) expect(normalizeExternalUrl(url)).toBeNull()
  })
})

describe('platformOf', () => {
  it.each([
    ['https://ethindia.devfolio.co', 'DEVFOLIO'],
    ['https://devpost.com/hackathons', 'DEVPOST'],
    ['https://hackmit.devpost.com', 'DEVPOST'],
    ['https://events.mlh.io/events/1', 'MLH'],
    ['https://unstop.com/hackathons/x', 'UNSTOP'],
    ['https://lu.ma/abc', 'LUMA'],
    ['https://notdevpost.com', 'OTHER'],
    ['https://devpost.com.evil.io', 'OTHER'],
  ])('%s is %s', (url, platform) => {
    expect(platformOf(url)).toBe(platform)
  })
})

describe('sanitizeText', () => {
  it('strips tags, scripts and control characters, decodes entities and caps the length', () => {
    expect(sanitizeText('<b>Hack</b> &amp; <script>alert(1)</script>Build&#33;\u0007', 100)).toBe('Hack & Build!')
    expect(sanitizeText('&lt;img src=x onerror=alert(1)&gt;', 100)).toBe('img src=x onerror=alert(1)')
    expect(sanitizeText('a'.repeat(50), 10)).toHaveLength(10)
    expect(sanitizeText('   ', 10)).toBeNull()
    expect(sanitizeText(42, 10)).toBeNull()
  })
})

describe('parseHackathonPage', () => {
  const jsonLd = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`

  it('reads a JSON-LD Event first', () => {
    const html = `<html><head><title>Fallback</title><meta property="og:title" content="OG name">${jsonLd({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'ETHIndia 2026',
      description: 'Asia&#39;s biggest <i>Ethereum</i> hackathon',
      startDate: '2026-12-05T09:00:00+05:30',
      endDate: '2026-12-07T18:00:00+05:30',
      image: '/cover.png',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Bengaluru', addressCountry: 'IN' } },
    })}</head></html>`
    const page = parseHackathonPage(html, 'https://ethindia.devfolio.co/')
    expect(page).toEqual({
      name: 'ETHIndia 2026',
      description: "Asia's biggest Ethereum hackathon",
      image: 'https://ethindia.devfolio.co/cover.png',
      startDate: new Date('2026-12-05T03:30:00Z'),
      endDate: new Date('2026-12-07T12:30:00Z'),
      mode: 'IN_PERSON',
      city: 'Bengaluru',
      country: 'IN',
    })
  })

  it('finds the event inside a @graph and reads an online or mixed one', () => {
    const online = parseHackathonPage(jsonLd({ '@graph': [{ '@type': 'WebPage' }, { '@type': ['Event', 'Hackathon'], name: 'Online Jam', location: { '@type': 'VirtualLocation', url: 'https://x' } }] }), 'https://x.io')
    expect(online).toMatchObject({ name: 'Online Jam', mode: 'ONLINE' })
    expect(parseHackathonPage(jsonLd({ '@type': 'Event', name: 'H', eventAttendanceMode: 'MixedEventAttendanceMode' }), 'https://x.io').mode).toBe('HYBRID')
  })

  it('falls back to OpenGraph, Twitter and the title, whatever order the attributes are in', () => {
    const html = `<head><title> Title &amp; more </title><meta content="The OG description" property="og:description"><meta name='twitter:image' content='https://cdn.example.com/a.jpg'></head>`
    expect(parseHackathonPage(html, 'https://example.com')).toMatchObject({ name: 'Title & more', description: 'The OG description', image: 'https://cdn.example.com/a.jpg', startDate: null, mode: null })
  })

  it('keeps nothing executable and survives broken markup', () => {
    const html = `<meta property="og:title" content="<script>alert(1)</script>Real name"><meta property="og:image" content="javascript:alert(1)"><script type="application/ld+json">{ not json</script>`
    const page = parseHackathonPage(html, 'https://example.com')
    expect(page.name).toBe('Real name')
    expect(page.image).toBeNull()
    expect(jsonLdObjects(html)).toEqual([])
  })

  it('ignores dates that are not dates, or absurdly far away', () => {
    expect(parseHackathonPage(jsonLd({ '@type': 'Event', name: 'X', startDate: 'soon', endDate: '9999-01-01' }), 'https://x.io')).toMatchObject({ startDate: null, endDate: null })
  })
})

describe('statusByDates', () => {
  const start = new Date('2026-11-01T00:00:00Z')
  const end = new Date('2026-11-03T00:00:00Z')
  it('is upcoming, active, then ended', () => {
    expect(statusByDates(start, end, new Date('2026-10-01T00:00:00Z'))).toBe('UPCOMING')
    expect(statusByDates(start, end, new Date('2026-11-02T00:00:00Z'))).toBe('ACTIVE')
    expect(statusByDates(start, end, new Date('2026-11-04T00:00:00Z'))).toBe('ENDED')
  })
})
