// What the share cards may print. The cards are drawn with Inter's Latin and Latin Extended glyphs (assets/fonts), which cover most European names and none of the
// rest; a character the fonts cannot draw would come out as an empty box. A name in another script is therefore not drawn: the card falls back to the @username
// (which is Latin by the platform's own rule) instead of showing boxes.

const COVERED = /^[ -ɏḀ-ỿ‐-‧‰-⁞€™←-↓ -ÿ]*$/u

/** Whether every character of the text has a glyph in the bundled fonts. */
export function renderable(text: string): boolean {
  return COVERED.test(text.normalize('NFC'))
}

/** The text if the fonts can draw it, else the fallback. Also strips control characters and collapses whitespace. */
export function drawable(text: string | null | undefined, fallback: string | null = null): string | null {
  if (!text) return fallback
  const tidy = text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  return tidy && renderable(tidy) ? tidy : fallback
}

/** At most `max` characters, cut at a word where there is one near the end, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Markdown reduced to the words: links to their text, emphasis, headings, quotes, list markers and code fences dropped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\n)[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/g, '$1')
    .replace(/[*`~]+/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
