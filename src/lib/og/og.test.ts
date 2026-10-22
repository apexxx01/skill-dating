import { describe, it, expect } from 'vitest'
import { clip, drawable, plainText, renderable } from './text'
import { etagOf, matchesEtag } from './render'
import { cardElement, LAYOUT_VERSION } from './layout'
import type { CardModel } from './models'

describe('what the fonts can draw', () => {
  it('draws Latin, Latin Extended, digits and ordinary punctuation', () => {
    for (const text of ['Grace Hopper', 'José Ñandú', 'Łukasz Żółć', 'Đorđe Ünal', 'Ship it! (v2) — “quoted” & 100%', 'Việt Nam']) expect(renderable(text), text).toBe(true)
  })

  it('refuses a script, an emoji or a symbol it has no glyph for, so a card never shows empty boxes', () => {
    for (const text of ['日本語', 'हिन्दी', 'مرحبا', 'Привет', 'Ada 😀', 'Ada ★']) expect(renderable(text), text).toBe(false)
  })

  it('falls back when it cannot draw, and tidies control characters and spacing', () => {
    expect(drawable('Привет', 'fallback')).toBe('fallback')
    expect(drawable('  Ada\n\tLovelace  ')).toBe('Ada Lovelace')
    expect(drawable(null, 'x')).toBe('x')
    expect(drawable('   ')).toBeNull()
  })
})

describe('clip and plainText', () => {
  it('cuts at a word near the end, with an ellipsis, and leaves short text alone', () => {
    expect(clip('short', 10)).toBe('short')
    expect(clip('the quick brown fox jumps over', 20)).toBe('the quick brown…')
    expect(clip('x'.repeat(50), 10)).toHaveLength(10)
  })

  it('reduces Markdown to its words: links to their text, code, images and bare URLs gone', () => {
    expect(plainText('# Title\n\nSee [the docs](https://example.com/a) and https://example.com/b\n\n```js\nconst x = 1\n```\n![alt](u.png) **bold** `code`')).toBe('Title See the docs and bold code')
    expect(plainText('It **works**. A_snake_case word, _emphasis_ here.\n- one\n- two\n> quoted')).toBe('It works. A_snake_case word, emphasis here. one two quoted')
  })
})

describe('ETags', () => {
  const card: CardModel = { kind: 'passport', username: 'ada', name: 'Ada', headline: null, role: null, skills: ['Rust'], level: 3, tier: 'BRONZE', projectsShipped: 1, achievements: 2 }

  it('is the same for the same picture and changes when anything drawn changes', () => {
    expect(etagOf(card)).toBe(etagOf({ ...card }))
    expect(etagOf({ ...card, level: 4 })).not.toBe(etagOf(card))
    expect(etagOf({ ...card, name: null })).not.toBe(etagOf(card))
    expect(etagOf(card)).toMatch(/^"og-[0-9a-f]{24}"$/)
  })

  it('knows the layout version is part of it', () => {
    expect(LAYOUT_VERSION).toMatch(/^l\d+$/)
  })

  it('recognises the tag in If-None-Match: one, a list, weak, or *', () => {
    const tag = etagOf(card)
    expect(matchesEtag(tag, tag)).toBe(true)
    expect(matchesEtag(`"other", ${tag}`, tag)).toBe(true)
    expect(matchesEtag(`W/${tag}`, tag)).toBe(true)
    expect(matchesEtag('*', tag)).toBe(true)
    expect(matchesEtag('"other"', tag)).toBe(false)
    expect(matchesEtag(null, tag)).toBe(false)
  })
})

describe('the layouts', () => {
  const cards: CardModel[] = [
    { kind: 'passport', username: 'ada', name: 'Ada Lovelace', headline: 'Builds engines', role: 'Mathematician', skills: ['Rust', 'Analysis'], level: 7, tier: 'SILVER', projectsShipped: 3, achievements: 9 },
    { kind: 'passport', username: 'kid', name: null, headline: null, role: null, skills: [], level: 1, tier: 'BRONZE', projectsShipped: 0, achievements: 0 },
    { kind: 'post', title: 'Shipped a compiler', excerpt: 'It parses.', postKind: 'SHIP', author: '@ada', propsCount: 4, commentCount: 1 },
    { kind: 'squad', squad: 'Night Shift', hackathon: 'HackNight', rank: 2, project: 'Compiler', memberCount: 4, members: ['@ada', '@grace'], unnamed: 2 },
    { kind: 'achievement', name: 'First ship', description: 'Shipped a project', xp: 100, rarityPercent: 12.5, earnedOn: '2026-10-22', holder: '@ada' },
  ]

  it('draws every card from its model alone, with no empty boxes for the optional parts', () => {
    for (const card of cards) {
      const element = cardElement(card)
      expect(element.type).toBe('div')
      const json = JSON.stringify(element)
      expect(json).not.toContain('undefined')
      expect(json).not.toContain('null%')
    }
  })

  it('prints a minor’s card with the username and no name', () => {
    const json = JSON.stringify(cardElement(cards[1]))
    expect(json).toContain('@kid')
    expect(json).not.toContain('Ada')
  })
})
