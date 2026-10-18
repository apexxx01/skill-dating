// Server-side sanitising of the text of a post (Markdown). The API stores and returns Markdown SOURCE; a client renders it. What is guaranteed
// here is that however a client renders it, the source cannot carry markup or a dangerous link:
//
//   - raw HTML is neutralised: every "<" becomes "&lt;", so no tag, comment, script or style element can form (Markdown's own constructs do not
//     need "<"; the one that does, the <https://...> autolink, is rewritten as a plain link first);
//   - a link or image destination must be http or https (a link may also be an in-page "#anchor" or a "mailto:"); anything else, including
//     "javascript:", "data:" and "vbscript:" however it is spelled (case, whitespace, control characters, entities), becomes "#";
//   - an image must be https;
//   - control characters, bidirectional overrides and zero-width characters are removed, and the text is normalised (NFC);
//   - runs of blank lines are collapsed.
//
// Pure. Length limits are the caller's schema's job; this function never throws.

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g
const MAX_BLANK_LINES = 2

/** The scheme of a destination as a browser would read it, or null when it has none (a relative path or an anchor). */
export function schemeOf(destination: string): string | null {
  // Browsers ignore tabs, newlines and other control characters inside a scheme, and leading whitespace; HTML entities are decoded in attributes.
  const decoded = destination
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16))))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(dec, 10))))
    .replace(/&(colon|Tab|NewLine);?/gi, (_, name: string) => (name.toLowerCase() === 'colon' ? ':' : ''))
  const cleaned = decoded.replace(/[\u0000-\u0020\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)
  return match ? match[1].toLowerCase() : null
}

export type DestinationKind = 'link' | 'image'

/** Whether a destination may stay as written. */
export function destinationAllowed(destination: string, kind: DestinationKind): boolean {
  const trimmed = destination.trim()
  if (trimmed === '') return false
  const scheme = schemeOf(trimmed)
  if (scheme === null) {
    // No scheme: an in-page anchor is fine for a link; a relative path is not allowed (a post is read away from its origin).
    return kind === 'link' && trimmed.startsWith('#')
  }
  if (kind === 'image') return scheme === 'https'
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
}

function cleanDestination(destination: string, kind: DestinationKind): string {
  return destinationAllowed(destination, kind) ? destination.trim() : '#'
}

export function sanitizeMarkdown(input: string): string {
  let text = input.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(INVISIBLE, '')

  // <https://example.com> autolinks become ordinary links before "<" is neutralised.
  text = text.replace(/<((?:https?|mailto):[^<>\s]+)>/gi, (_, url: string) => `[${url}](${url})`)

  // Inline links and images: [text](destination "title") and ![alt](destination). The destination is the part up to the first space or the closing parenthesis (one level of balanced parentheses inside it is part of it, as in CommonMark).
  text = text.replace(/(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)((?:\s+"[^"\n]*")?)\s*\)/g, (_match, bang: string, label: string, destination: string, title: string) => {
    const bare = destination.startsWith('<') && destination.endsWith('>') ? destination.slice(1, -1) : destination
    return `${bang}[${label}](${cleanDestination(bare, bang ? 'image' : 'link')}${title})`
  })

  // What the pass above did not recognise as a link (a destination with a tab or a space inside the scheme, an unbalanced bracket) is not a link in
  // CommonMark, but a lenient renderer may treat it as one: after "](" a dangerous scheme, however it is spelled, is replaced the same way.
  text = text.replace(/\]\(([^)]*)/g, (match, content: string) => {
    const scheme = schemeOf(content)
    return scheme !== null && scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto' ? '](#' : match
  })

  // Reference definitions: [id]: destination "title"
  text = text.replace(/^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|\S*)(.*)$/gm, (_match, head: string, destination: string, rest: string) => {
    const bare = destination.startsWith('<') && destination.endsWith('>') ? destination.slice(1, -1) : destination
    return `${head}${cleanDestination(bare, 'link')}${rest}`
  })

  // Whatever "<" is left would start a tag.
  text = text.replace(/</g, '&lt;')

  // Blank lines, and trailing whitespace on each line.
  text = text.replace(/[ \t]+$/gm, '').replace(new RegExp(`\\n{${MAX_BLANK_LINES + 2},}`, 'g'), '\n'.repeat(MAX_BLANK_LINES + 1))
  return text.trim()
}

/** Single-line text (a title): no newlines, no markup characters that matter, collapsed spaces. */
export function sanitizeLine(input: string): string {
  return input
    .normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** A plain-text excerpt of Markdown, for notifications and previews. */
export function excerptOf(markdown: string, length = 140): string {
  const plain = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]+/g, '')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length <= length ? plain : `${plain.slice(0, length - 1).trimEnd()}…`
}

/** Whether a URL may be listed as a link of a post: absolute http(s), no credentials. */
export function isPublicLink(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
  } catch {
    return false
  }
}
