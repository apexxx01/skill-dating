import { createHash } from 'crypto'

// What a spark's opener has to be. The point of an opener is a real reason to talk, so the checks go after what spam and low effort look like
// rather than after anything a person might honestly write. Pure; the database only supplies the sender's recent openers.
//
//  - 20 to 280 characters, and at least five words: "hey whats up" is not an opener;
//  - not a stock phrase with nothing added ("let's connect", "love your profile", "would love to pick your brain");
//  - no links, e-mail addresses or phone numbers, and no invitation to talk somewhere else: they can all be shared once there is a match;
//  - not characters or words repeated to fill space;
//  - not the same message again: the same words, or nearly, as one the sender used in their last 30 days of sparks.

export const OPENER_MIN_LENGTH = 20
export const OPENER_MAX_LENGTH = 280
export const OPENER_MIN_WORDS = 5
/** How alike two openers may be (0 to 1, by shared words) before the second is called a repeat. */
export const OPENER_SIMILARITY_LIMIT = 0.8

export type OpenerProblem = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_FEW_WORDS' | 'LOW_EFFORT' | 'LINK' | 'CONTACT_DETAILS' | 'REPEATED_CHARACTERS' | 'DUPLICATE'

export type OpenerCheck = { ok: true } | { ok: false; problem: OpenerProblem; message: string }

const MESSAGES: Record<OpenerProblem, string> = {
  TOO_SHORT: `Write at least ${OPENER_MIN_LENGTH} characters: say why you want to talk to this person`,
  TOO_LONG: `Keep it to ${OPENER_MAX_LENGTH} characters`,
  TOO_FEW_WORDS: 'Say a little more: a real reason to talk takes more than a few words',
  LOW_EFFORT: 'That reads like a message you could send anyone. Mention something specific about them or what you would build together',
  LINK: 'Leave links out of the opener; you can share them once you have matched',
  CONTACT_DETAILS: 'Leave contact details out of the opener; you can share them once you have matched',
  REPEATED_CHARACTERS: 'That does not read like a real message',
  DUPLICATE: 'You have sent almost the same opener to someone else. Write this one for this person',
}

/** Lower case, accents and punctuation gone, one space between words: what two openers are compared on. */
export function normalizeOpener(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A fingerprint of an opener's words, to find the same message sent again whatever its punctuation and case. */
export function openerHash(text: string): string {
  return createHash('sha256').update(normalizeOpener(text)).digest('hex').slice(0, 32)
}

const words = (text: string) => normalizeOpener(text).split(' ').filter(Boolean)

/** Share of words two openers have in common, over the words either has (0 to 1). Symmetric. */
export function openerSimilarity(a: string, b: string): number {
  const left = new Set(words(a))
  const right = new Set(words(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

const URL_PATTERN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|co|me|dev|app|ly|xyz|net|org|ai|gg)\b)/i
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/
const PHONE_PATTERN = /(\+?\d[\d\s().-]{7,}\d)/
const OFF_PLATFORM_PATTERN = /\b(whats\s?app|telegram|snap\s?chat|snapchat|wechat|kik|signal me|text me|call me|dm me on)\b/i

/** Phrases that say nothing. An opener that is only these (and filler) is low effort. */
const STOCK_PHRASES: RegExp[] = [
  /\b(hi|hey|hello|hola|yo|sup|heyy+|hii+|greetings)\b/g,
  /\b(how are you( doing)?|how s it going|how is it going|what s up|whats up|wassup|how do you do)\b/g,
  /\b(let s|lets|would love to|i would love to|i d love to|id love to|want to|wanna|i want to|can we|could we|i would like to|i d like to)\s+(connect|chat|talk|collaborate|network|meet|speak|team up)\b/g,
  /\b(love|like|nice|great|cool|amazing|awesome|impressive|interesting) (your )?(profile|work|bio|projects?|background|skills|stuff)\b/g,
  /\b(you look|you seem|you re|you are) (really |very |so )?(interesting|cool|nice|amazing|great|awesome|cute|pretty|talented)\b/g,
  /\b(pick your brain|add you to my( professional)? network|came across your profile|saw your profile|found your profile|reaching out|just wanted to say|thought i d say)\b/g,
  /\b(we would|we d|we could|we should|i think we would|i think we d) (be )?(a )?(great|good|perfect) (match|fit|team|duo|pair)\b/g,
  /\b(please|thanks|thank you|pls|kindly|just|really|very|so|and|the|a|an|to|you|i|we|me|my|your|of|in|on|it|is|are|be|with|for|at|up|sometime|soon|later|today|tomorrow|again|now|there|here|some|any|time|out|about|that|this)\b/g,
]

/** What is left of an opener after the stock phrases and filler are taken out. */
function substance(text: string): string[] {
  let rest = ` ${normalizeOpener(text)} `
  for (const pattern of STOCK_PHRASES) rest = rest.replace(pattern, ' ')
  return rest.split(/\s+/).filter((word) => word.length > 1)
}

/**
 * Whether `opener` is acceptable, given the openers the sender used in their recent sparks. Checked in the order the problems are
 * cheapest to explain. The text is judged as written, trimmed.
 */
export function checkOpener(opener: string, recent: readonly string[] = []): OpenerCheck {
  const text = opener.trim()
  const fail = (problem: OpenerProblem): OpenerCheck => ({ ok: false, problem, message: MESSAGES[problem] })

  const length = [...text].length
  if (length < OPENER_MIN_LENGTH) return fail('TOO_SHORT')
  if (length > OPENER_MAX_LENGTH) return fail('TOO_LONG')
  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text) || OFF_PLATFORM_PATTERN.test(text)) return fail('CONTACT_DETAILS')
  if (URL_PATTERN.test(text)) return fail('LINK')
  if (/(.)\1{5,}/u.test(text) || new Set([...normalizeOpener(text).replace(/\s/g, '')]).size < 6) return fail('REPEATED_CHARACTERS')
  if (words(text).length < OPENER_MIN_WORDS) return fail('TOO_FEW_WORDS')
  if (substance(text).length < 3) return fail('LOW_EFFORT')
  const hash = openerHash(text)
  for (const previous of recent) {
    if (openerHash(previous) === hash || openerSimilarity(text, previous) >= OPENER_SIMILARITY_LIMIT) return fail('DUPLICATE')
  }
  return { ok: true }
}
