import { describe, it, expect } from 'vitest'
import config from '@/config/banned-terms.json'
import { checkContent, findLinks, hasContactDetails, matchedTerms, REPEAT_LIMITS } from './content'

describe('banned terms (from config)', () => {
  it('reads every term from the config file', () => {
    expect(config.terms.length).toBeGreaterThan(5)
    for (const entry of config.terms) expect(['hard', 'soft']).toContain(entry.severity)
  })

  it('refuses a hard term and flags a soft one', () => {
    expect(checkContent('Quick question: send me your password so I can fix it', { surface: 'MESSAGE' })).toEqual({ verdict: 'REJECT', reasons: ['BANNED_TERM'], terms: ['send me your password'] })
    expect(checkContent('I have an investment opportunity for builders', { surface: 'POST' })).toMatchObject({ verdict: 'FLAG', reasons: ['BANNED_TERM'] })
  })

  it('sees through look-alike characters, case and punctuation', () => {
    expect(matchedTerms('GUARANTEED-returns!!').map((t) => t.term)).toEqual(['guaranteed returns'])
    expect(matchedTerms('d0uble y0ur crypt0').map((t) => t.term)).toEqual(['double your crypto'])
    expect(matchedTerms('guаranteed returns').map((t) => t.term)).toEqual(['guaranteed returns']) // Cyrillic а
  })

  it('matches whole words only', () => {
    expect(matchedTerms('the rewire me project')).toEqual([])
  })
})

describe('links', () => {
  it('finds links with and without a scheme', () => {
    expect(findLinks('see https://example.com/a and www.test.io and repo.dev/x')).toHaveLength(3)
  })

  it('lets a few links through, flags more, and refuses a wall of them', () => {
    const links = (n: number) => Array.from({ length: n }, (_, i) => `https://site${i}.com`).join(' ')
    expect(checkContent(`notes ${links(3)}`, { surface: 'MESSAGE' }).verdict).toBe('ALLOW')
    expect(checkContent(`notes ${links(4)}`, { surface: 'MESSAGE' })).toMatchObject({ verdict: 'FLAG', reasons: ['LINK_SPAM'] })
    expect(checkContent(`notes ${links(9)}`, { surface: 'MESSAGE' })).toMatchObject({ verdict: 'REJECT', reasons: ['LINK_SPAM'] })
    expect(checkContent(`notes ${links(3)}`, { surface: 'COMMENT' }).verdict).toBe('FLAG')
  })

  it('flags a link shortener', () => {
    expect(checkContent('my demo: https://bit.ly/abc123', { surface: 'POST' })).toMatchObject({ verdict: 'FLAG', reasons: ['LINK_SHORTENER'] })
  })
})

describe('contact details', () => {
  it('spots e-mail addresses, phone numbers and invitations elsewhere', () => {
    expect(hasContactDetails('mail me at ada@example.com')).toBe(true)
    expect(hasContactDetails('call +91 98765 43210')).toBe(true)
    expect(hasContactDetails('ping me on telegram')).toBe(true)
    expect(hasContactDetails('add me on wa.me/123')).toBe(true)
    expect(hasContactDetails('I shipped 3 projects in 2025')).toBe(false)
  })

  it('refuses links and contact details in openers and the first romance messages, and allows them in messages', () => {
    expect(checkContent('Loved your demo, mail me at ada@example.com', { surface: 'OPENER' })).toMatchObject({ verdict: 'REJECT', reasons: ['CONTACT_DETAILS'] })
    expect(checkContent('Hi! see my site https://ada.dev', { surface: 'FIRST_ROMANCE_MESSAGE' })).toMatchObject({ verdict: 'REJECT', reasons: ['LINK_NOT_ALLOWED'] })
    expect(checkContent('Hi! text me on whatsapp', { surface: 'FIRST_ROMANCE_MESSAGE' }).reasons).toContain('CONTACT_DETAILS')
    expect(checkContent('mail me at ada@example.com', { surface: 'MESSAGE' }).verdict).toBe('ALLOW')
  })
})

describe('repeated content', () => {
  it('flags the same text sent a few times and refuses it after more', () => {
    expect(checkContent('hello builders', { surface: 'MESSAGE', repeats: REPEAT_LIMITS.flagAt - 1 }).verdict).toBe('ALLOW')
    expect(checkContent('hello builders', { surface: 'MESSAGE', repeats: REPEAT_LIMITS.flagAt })).toMatchObject({ verdict: 'FLAG', reasons: ['REPEATED'] })
    expect(checkContent('hello builders', { surface: 'MESSAGE', repeats: REPEAT_LIMITS.rejectAt })).toMatchObject({ verdict: 'REJECT', reasons: ['REPEATED'] })
  })
})

it('allows ordinary writing', () => {
  expect(checkContent('Shipped the new parser today. Benchmarks in the thread, feedback welcome!', { surface: 'POST' })).toEqual({ verdict: 'ALLOW', reasons: [], terms: [] })
})
