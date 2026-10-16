import { describe, it, expect } from 'vitest'
import { checkOpener, normalizeOpener, openerHash, openerSimilarity, OPENER_MAX_LENGTH, OPENER_MIN_LENGTH, type OpenerProblem } from './opener'

const problem = (text: string, recent: string[] = []): OpenerProblem | null => {
  const result = checkOpener(text, recent)
  return result.ok ? null : result.problem
}

const GOOD = [
  'I saw your Rust parser project and I am building a type checker that needs someone who has done parsing. Want to compare notes?',
  'Your hackathon write-up on offline-first sync is exactly the problem we hit at Kolkata Build Week, would you pair for a weekend?',
  'We both want to ship an MVP by December and you know the ML side I keep putting off. I can do the React front end and the auth.',
  'Looking for a mentor on distributed systems: your Postgres replication talk answered half my questions, and I have a dozen more.',
  'Ich suche jemanden für das Backend meines Projekts, und dein Go-Projekt zeigt genau das, was mir fehlt. Wollen wir sprechen?',
]

describe('checkOpener: what is accepted', () => {
  it.each(GOOD)('accepts %s', (text) => {
    expect(checkOpener(text)).toEqual({ ok: true })
  })

  it('accepts exactly the minimum and the maximum length', () => {
    const minimum = 'Rust parser help? Join my team'
    expect([...minimum].length).toBeGreaterThanOrEqual(OPENER_MIN_LENGTH)
    expect(problem(minimum)).toBeNull()
    const long = ('I need a backend engineer for my graph database project. ').repeat(5).slice(0, OPENER_MAX_LENGTH)
    expect([...long].length).toBe(OPENER_MAX_LENGTH)
    expect(problem(long)).toBeNull()
  })

  it('counts characters, not UTF-16 units, so emoji and accents do not eat the limit', () => {
    const text = `Shipping a robotics demo 🤖🤖🤖 and need firmware help, ${'é'.repeat(200)}`
    expect([...text].length).toBeLessThanOrEqual(OPENER_MAX_LENGTH)
    expect(problem(text)).not.toBe('TOO_LONG')
  })
})

describe('checkOpener: length and words', () => {
  it('refuses under 20 and over 280 characters, trimming the spaces first', () => {
    expect(problem('Let us build a thing')).toBeNull()
    expect(problem('Want to build?')).toBe('TOO_SHORT')
    expect(problem('   a   b   ')).toBe('TOO_SHORT')
    expect(problem('')).toBe('TOO_SHORT')
    expect(problem('x '.repeat(200))).toBe('TOO_LONG')
    expect(problem('a'.repeat(OPENER_MAX_LENGTH + 1))).toBe('TOO_LONG')
  })

  it('needs a few words, not one long one', () => {
    expect(problem('Supercalifragilisticexpialidocious')).not.toBeNull()
    expect(problem('Interested in collaborating together')).toBe('TOO_FEW_WORDS')
  })
})

describe('checkOpener: low effort', () => {
  it.each([
    'Hey there, how are you doing today?',
    "Let's connect and chat sometime soon!",
    'Love your profile, would love to connect',
    'I would love to pick your brain please',
    'Hello! I came across your profile and would love to add you to my professional network',
    'You look really interesting, we should talk',
    'Hey, I think we would be a great match!',
    'Nice profile, great work, amazing projects',
    'Hey! Hey! Hey! Want to team up?',
  ])('refuses the stock message %s', (text) => {
    expect(problem(text)).toBe('LOW_EFFORT')
  })

  it('does not refuse a real opener for starting with a greeting', () => {
    expect(problem('Hey! I read your post about WebSockets at scale and I am stuck on the same reconnect storm. Can I ask how you solved it?')).toBeNull()
    expect(problem('Hi, I am building a payments API in Go and you have shipped three of them. Would you review my design?')).toBeNull()
  })
})

describe('checkOpener: links and contact details', () => {
  it.each(['Check out my project at https://example.com/demo and tell me what you think', 'See www.myapp.dev for what I built and join in', 'Look at github.io style pages like mine.dev please', 'My site is cool-app.io, want to build with me this year?'])(
    'refuses a link in %s',
    (text) => {
      expect(problem(text)).toBe('LINK')
    }
  )

  it.each([
    'Email me at someone@example.org about the project we discussed',
    'Call me on +1 (415) 555-0100 about this build please',
    'Text me when you are free, I have a project idea for you',
    'Add me on WhatsApp and we can talk about the startup',
    'Message me on Telegram about the hackathon team idea',
  ])('refuses contact details in %s', (text) => {
    expect(problem(text)).toBe('CONTACT_DETAILS')
  })

  it('lets a year or a short number through', () => {
    expect(problem('We shipped 3 projects in 2025 and want a fourth with someone who knows embedded systems')).toBeNull()
  })
})

describe('checkOpener: filler', () => {
  it('refuses characters repeated to fill space', () => {
    expect(problem('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('REPEATED_CHARACTERS')
    expect(problem('hahahahahaaaaaaaaaaaaaaa hello there friend')).toBe('REPEATED_CHARACTERS')
    expect(problem('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')).toBe('REPEATED_CHARACTERS')
  })
})

describe('checkOpener: the same message again', () => {
  const sent = 'I loved your talk on event sourcing, I am building something similar for payments and need a second brain on it.'

  it('refuses the same words, whatever the case and punctuation', () => {
    expect(problem(sent, [sent])).toBe('DUPLICATE')
    expect(problem(sent.toUpperCase(), [sent])).toBe('DUPLICATE')
    expect(problem(sent.replace(/,/g, '').replace('.', '!!!'), [sent])).toBe('DUPLICATE')
    expect(problem('  ' + sent + '  ', [sent])).toBe('DUPLICATE')
  })

  it('refuses nearly the same words, as a template with one word changed', () => {
    const template = (topic: string) => `I loved your talk on ${topic}, I am building something similar for payments and need a second brain on it.`
    expect(problem(template('event sourcing'), [template('event streaming')])).toBe('DUPLICATE')
    expect(problem(template('event sourcing'), [template('CRDTs')])).toBe('DUPLICATE')
  })

  it('lets a different message to a different person through, even on the same theme', () => {
    expect(problem('Your CRDT write-up convinced me offline editing is solvable, would you pair on a prototype for my notes app this month?', [sent])).toBeNull()
  })

  it('checks every recent opener, and ignores none being there', () => {
    expect(problem(sent, [])).toBeNull()
    expect(problem(sent, ['something completely different about robotics and drones for farms', sent])).toBe('DUPLICATE')
  })

  it('checks the problems in order: a link is a link before it is a repeat', () => {
    const withLink = `${sent} https://example.com`
    expect(problem(withLink, [withLink])).toBe('LINK')
  })
})

describe('normalizeOpener, openerHash and openerSimilarity', () => {
  it('normalise case, accents, punctuation and spacing', () => {
    expect(normalizeOpener('  Héllo,   WORLD!! — it’s me  ')).toBe('hello world it s me')
  })

  it('hash alike for the same words and apart for different ones', () => {
    expect(openerHash('Hello, world!')).toBe(openerHash('  hello   WORLD '))
    expect(openerHash('hello world')).not.toBe(openerHash('hello there'))
    expect(openerHash('x')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('measure how alike two openers are, symmetrically, from 0 to 1', () => {
    expect(openerSimilarity('a b c d', 'a b c d')).toBe(1)
    expect(openerSimilarity('a b c d', 'e f g h')).toBe(0)
    expect(openerSimilarity('a b c d', 'a b c e')).toBeCloseTo(3 / 5, 9)
    expect(openerSimilarity('a b c d', 'a b c e')).toBe(openerSimilarity('a b c e', 'a b c d'))
    expect(openerSimilarity('', 'a b')).toBe(0)
  })
})
