import { describe, it, expect } from 'vitest'
import { destinationAllowed, excerptOf, isPublicLink, sanitizeLine, sanitizeMarkdown, schemeOf } from './sanitize'

describe('raw HTML', () => {
  it('neutralises every tag so none can form', () => {
    expect(sanitizeMarkdown('hello <script>alert(1)</script> world')).toBe('hello &lt;script>alert(1)&lt;/script> world')
    expect(sanitizeMarkdown('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)>')
    expect(sanitizeMarkdown('<!-- hidden --><b>bold</b>')).toBe('&lt;!-- hidden -->&lt;b>bold&lt;/b>')
    expect(sanitizeMarkdown('<iframe src="https://evil.example"></iframe>')).not.toMatch(/<[a-z!\/]/i)
  })

  it('leaves no "<" at all in the output', () => {
    const nasty = ['<<script>script>', '< script>', '<svg/onload=1>', 'a < b and c > d', '<a href="javascript:alert(1)">x</a>']
    for (const text of nasty) expect(sanitizeMarkdown(text)).not.toContain('<')
  })

  it('keeps ordinary Markdown as it was', () => {
    const text = '# Title\n\n- one\n- two\n\n> quote\n\n`code` and **bold** and _italic_\n\n```ts\nconst a = 1 > 0\n```'
    expect(sanitizeMarkdown(text)).toBe(text)
  })
})

describe('link and image destinations', () => {
  it('allows http, https and mailto links and in-page anchors', () => {
    expect(sanitizeMarkdown('[a](https://example.com/x?y=1)')).toBe('[a](https://example.com/x?y=1)')
    expect(sanitizeMarkdown('[a](http://example.com)')).toBe('[a](http://example.com)')
    expect(sanitizeMarkdown('[a](mailto:me@example.com)')).toBe('[a](mailto:me@example.com)')
    expect(sanitizeMarkdown('[a](#section)')).toBe('[a](#section)')
    expect(sanitizeMarkdown('[a](https://example.com "A title")')).toBe('[a](https://example.com "A title")')
  })

  it('replaces every other scheme, however it is spelled, with #', () => {
    const bad = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav&#x61;script:alert(1)',
      'javascript&colon;alert(1)',
      '&#106;avascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      '//evil.example/x',
      '/relative/path',
      'ftp://example.com',
    ]
    for (const destination of bad) {
      const out = sanitizeMarkdown(`[click](${destination.replace(/\n/g, '')})`)
      expect(out.startsWith('[click](#)'), `${destination} -> ${out}`).toBe(true)
      expect(out.replace(/\s/g, '').toLowerCase(), destination).not.toMatch(/\]\((javascript|vbscript|data|file|ftp):/)
    }
    // Newlines inside a destination break the construct itself; the check above handled the spelled-out variants.
    expect(sanitizeMarkdown('[x](java\nscript:alert(1))')).not.toMatch(/\]\(java/)
  })

  it('allows only https images', () => {
    expect(sanitizeMarkdown('![alt](https://example.com/a.png)')).toBe('![alt](https://example.com/a.png)')
    expect(sanitizeMarkdown('![alt](http://example.com/a.png)')).toBe('![alt](#)')
    expect(sanitizeMarkdown('![alt](data:image/png;base64,AAAA)')).toBe('![alt](#)')
    expect(sanitizeMarkdown('![alt](javascript:alert(1))')).toBe('![alt](#)')
    expect(sanitizeMarkdown('![alt](/local.png)')).toBe('![alt](#)')
  })

  it('handles angle-bracketed destinations, autolinks and reference definitions', () => {
    expect(sanitizeMarkdown('[a](<javascript:alert(1)>)')).toBe('[a](#)')
    expect(sanitizeMarkdown('<https://example.com/a>')).toBe('[https://example.com/a](https://example.com/a)')
    expect(sanitizeMarkdown('<javascript:alert(1)>')).toBe('&lt;javascript:alert(1)>')
    expect(sanitizeMarkdown('[ref]: javascript:alert(1)\n[ok]: https://example.com')).toBe('[ref]: #\n[ok]: https://example.com')
  })

  it('exposes the rule', () => {
    expect(destinationAllowed('https://a.example', 'link')).toBe(true)
    expect(destinationAllowed('https://a.example', 'image')).toBe(true)
    expect(destinationAllowed('http://a.example', 'image')).toBe(false)
    expect(destinationAllowed('', 'link')).toBe(false)
    expect(schemeOf('  JAVASCRIPT:1')).toBe('javascript')
    expect(schemeOf('example.com/page')).toBeNull()
  })
})

describe('characters', () => {
  it('removes control, bidirectional and zero-width characters and normalises', () => {
    expect(sanitizeMarkdown('a\u0000b\u0007c')).toBe('abc')
    expect(sanitizeMarkdown('safe‮txt.exe')).toBe('safetxt.exe')
    expect(sanitizeMarkdown('zero​width﻿')).toBe('zerowidth')
    expect(sanitizeMarkdown('é')).toBe('é')
  })

  it('collapses runs of blank lines and trims', () => {
    expect(sanitizeMarkdown('a\n\n\n\n\n\nb   \n')).toBe('a\n\n\nb')
    expect(sanitizeMarkdown('\r\nwindows\r\nline\r\n')).toBe('windows\nline')
  })

  it('is idempotent', () => {
    const samples = ['<script>x</script> [a](javascript:1) ![b](http://x)', '# hi\n\n\n\n\n<b>', '[a](https://x.example "t")\n[ref]: <data:x>']
    for (const text of samples) expect(sanitizeMarkdown(sanitizeMarkdown(text))).toBe(sanitizeMarkdown(text))
  })
})

describe('lines, excerpts and links', () => {
  it('makes a title one clean line', () => {
    expect(sanitizeLine('  Shipped\n  the   <b>thing</b>\t! ')).toBe('Shipped the &lt;b>thing&lt;/b> !')
  })

  it('makes a plain excerpt of Markdown', () => {
    expect(excerptOf('# Big news\n\nWe **shipped** [the app](https://example.com) today')).toBe('Big news We shipped the app today')
    expect(excerptOf('x'.repeat(300), 20)).toHaveLength(20)
    expect(excerptOf('x'.repeat(300), 20).endsWith('…')).toBe(true)
  })

  it('accepts only absolute web links without credentials', () => {
    expect(isPublicLink('https://github.com/a/b')).toBe(true)
    expect(isPublicLink('http://example.com')).toBe(true)
    expect(isPublicLink('https://user:pw@example.com')).toBe(false)
    expect(isPublicLink('javascript:alert(1)')).toBe(false)
    expect(isPublicLink('/relative')).toBe(false)
    expect(isPublicLink('not a url')).toBe(false)
  })
})
