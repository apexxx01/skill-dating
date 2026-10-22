import { SEARCH_LIMITS, SEARCH_TYPES, type SearchType } from './types'

// Turning what a person typed into what the database is asked. Pure: the one place the text is tidied, so a provider never sees raw input.

/**
 * Lower-case, accents removed, compatibility forms folded (NFKC first: full-width letters, ligatures). Only the combining diacritical marks (U+0300 to U+036F: the accents of
 * Latin, Greek and Cyrillic) are dropped. Marks of other scripts are letters in all but name (a Devanagari vowel sign, a Japanese voicing mark) and stay.
 */
export function foldText(value: string): string {
  return value.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase()
}

// Letters, digits and underscore, and the marks that belong to letters (Devanagari vowel signs, Thai tone marks): a word is not cut in the middle of a syllable.
const WORD = /[\p{L}\p{N}\p{M}_]+/gu

export interface TidyQuery {
  text: string
  words: string[]
}

/** The words of a query, tidied: at most 8 of at most 40 characters. The text is those words with single spaces, which is what trigram matching and prefixes use. */
export function tidyQuery(raw: string): TidyQuery {
  const words = (foldText(raw.slice(0, SEARCH_LIMITS.maxQueryLength * 2)).match(WORD) ?? []).map((word) => word.slice(0, SEARCH_LIMITS.maxWordLength)).slice(0, SEARCH_LIMITS.maxWords)
  return { text: words.join(' '), words }
}

/** Whether a tidied query is long enough to search: two letters or digits. A shorter one answers an empty list. */
export const isSearchable = (query: TidyQuery) => query.text.replace(/\s/g, '').length >= SEARCH_LIMITS.minQueryLength

/**
 * The tsquery for the words: every word a prefix, all required (`gra:* & hop:*`). The words are letters, digits and underscores only, so nothing in them is tsquery syntax;
 * it is still passed to the database as a parameter.
 */
export function prefixTsQuery(words: readonly string[]): string {
  return words.map((word) => `${word}:*`).join(' & ')
}

/** The text as a LIKE pattern for "starts with", with the characters LIKE treats specially escaped (the query is letters, digits and underscore, and underscore matters). */
export function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/** `types=users,posts` as a list; absent or empty means all. Unknown names make it invalid (null). */
export function parseTypes(raw: string | undefined): SearchType[] | null {
  if (raw === undefined || raw.trim() === '') return [...SEARCH_TYPES]
  const names = [...new Set(raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean))]
  if (names.length === 0 || names.some((name) => !(SEARCH_TYPES as readonly string[]).includes(name))) return null
  return names as SearchType[]
}
