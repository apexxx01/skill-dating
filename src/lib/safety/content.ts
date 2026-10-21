import config from '@/config/banned-terms.json'
import { skeleton } from '@/lib/identity/confusables'

// Server-side content checks for what people write to each other: messages, posts, comments and openers. Pure; the caller supplies how often the same
// text was sent lately (repeats.ts counts it). Two outcomes besides ALLOW:
//
//   REJECT  the text is refused (400 CONTENT_REJECTED, with the reasons): a hard banned term, a link or contact details where they are not allowed,
//           many more links than the surface allows, or the same text sent too many times in a row;
//   FLAG    the text goes through and a moderator gets an automatic report: a soft banned term, a link shortener, more links than usual, a repeat.
//
// The terms and the link shorteners are config (src/config/banned-terms.json), not code. Matching is on whole words of the normalised text, with
// look-alike characters folded (confusables.ts), so "fr33" or Cyrillic letters do not slip a term past it. Openers keep their own stricter rules
// (src/lib/matching/opener.ts) and pass through here too for the banned terms.

export type ContentSurface = 'MESSAGE' | 'POST' | 'COMMENT' | 'OPENER' | 'FIRST_ROMANCE_MESSAGE' | 'LFG' | 'IDEA'

export type ContentReason = 'BANNED_TERM' | 'LINK_SPAM' | 'LINK_SHORTENER' | 'LINK_NOT_ALLOWED' | 'CONTACT_DETAILS' | 'REPEATED'

export interface ContentVerdict {
  verdict: 'ALLOW' | 'FLAG' | 'REJECT'
  reasons: ContentReason[]
  /** The banned terms that matched, for the moderator (never shown to the writer). */
  terms: string[]
}

interface SurfaceRules {
  /** Links up to this many pass; more is flagged. */
  linksFlagAbove: number
  /** More than this many links is refused. */
  linksRejectAbove: number
  /** Whether links and contact details are refused outright. */
  noLinksOrContacts: boolean
}

export const CONTENT_RULES: Record<ContentSurface, SurfaceRules> = {
  MESSAGE: { linksFlagAbove: 3, linksRejectAbove: 8, noLinksOrContacts: false },
  POST: { linksFlagAbove: 5, linksRejectAbove: 12, noLinksOrContacts: false },
  COMMENT: { linksFlagAbove: 2, linksRejectAbove: 5, noLinksOrContacts: false },
  LFG: { linksFlagAbove: 3, linksRejectAbove: 6, noLinksOrContacts: false },
  IDEA: { linksFlagAbove: 3, linksRejectAbove: 6, noLinksOrContacts: false },
  // A spark opener (both modes): contacts and links can be shared once there is a match.
  OPENER: { linksFlagAbove: 0, linksRejectAbove: 0, noLinksOrContacts: true },
  // The first messages of a romance match (until both have written): no links and no contact details, so nobody is taken off the platform before trust exists.
  FIRST_ROMANCE_MESSAGE: { linksFlagAbove: 0, linksRejectAbove: 0, noLinksOrContacts: true },
}

/** The same text this many times in the repeat window is flagged; this many more is refused. */
export const REPEAT_LIMITS = { flagAt: 3, rejectAt: 5, windowMinutes: 10 } as const

const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|co|me|dev|app|ly|xyz|net|org|ai|gg|in|to|link|site|online|info|biz)\b(?:\/[^\s<>()]*)?/gi
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{7,}\d)/
const OFF_PLATFORM_PATTERN = /\b(?:whats\s?app|telegram|t\.me|wa\.me|snap\s?chat|wechat|kik|signal me|text me|call me|dm me on|insta(?:gram)?\s*[:@]|ig\s*[:@])/i

interface CompiledTerm {
  term: string
  severity: 'hard' | 'soft'
  pattern: string
}

/** A term's skeleton words, matched as whole words in the text's skeleton words (spaces kept between words). */
const wordsOf = (text: string) => text.toLowerCase().normalize('NFKD').split(/[^\p{L}\p{N}@$|]+/u).filter(Boolean).map(skeleton).filter(Boolean)

const TERMS: CompiledTerm[] = config.terms.map((entry) => ({ term: entry.term, severity: entry.severity === 'hard' ? 'hard' : 'soft', pattern: ` ${wordsOf(entry.term).join(' ')} ` }))
const SHORTENERS = new Set(config.linkShorteners.map((domain) => domain.toLowerCase()))

export function findLinks(text: string): string[] {
  return text.match(LINK_PATTERN) ?? []
}

export function hasContactDetails(text: string): boolean {
  return EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text) || OFF_PLATFORM_PATTERN.test(text)
}

function hostOf(link: string): string {
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function matchedTerms(text: string): CompiledTerm[] {
  const haystack = ` ${wordsOf(text).join(' ')} `
  return TERMS.filter((term) => term.pattern.trim().length > 0 && haystack.includes(term.pattern))
}

export function checkContent(text: string, options: { surface: ContentSurface; repeats?: number }): ContentVerdict {
  const rules = CONTENT_RULES[options.surface]
  const reject = new Set<ContentReason>()
  const flag = new Set<ContentReason>()

  const terms = matchedTerms(text)
  if (terms.some((term) => term.severity === 'hard')) reject.add('BANNED_TERM')
  else if (terms.length > 0) flag.add('BANNED_TERM')

  // An e-mail address looks like a link to the pattern; count it as contact details instead.
  const links = findLinks(text.replace(new RegExp(EMAIL_PATTERN.source, 'g'), ' '))
  if (rules.noLinksOrContacts) {
    if (links.length > 0) reject.add('LINK_NOT_ALLOWED')
    if (hasContactDetails(text)) reject.add('CONTACT_DETAILS')
  } else {
    if (links.length > rules.linksRejectAbove) reject.add('LINK_SPAM')
    else if (links.length > rules.linksFlagAbove) flag.add('LINK_SPAM')
    if (links.some((link) => SHORTENERS.has(hostOf(link)))) flag.add('LINK_SHORTENER')
  }

  const repeats = options.repeats ?? 0
  if (repeats >= REPEAT_LIMITS.rejectAt) reject.add('REPEATED')
  else if (repeats >= REPEAT_LIMITS.flagAt) flag.add('REPEATED')

  const names = terms.map((term) => term.term)
  if (reject.size > 0) return { verdict: 'REJECT', reasons: [...reject], terms: names }
  if (flag.size > 0) return { verdict: 'FLAG', reasons: [...flag], terms: names }
  return { verdict: 'ALLOW', reasons: [], terms: [] }
}
