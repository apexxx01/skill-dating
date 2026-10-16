// Where a person is, for the location leaderboards: an ISO 3166-1 alpha-2 country code, and a
// city and a campus entered as free text. Free text is cleaned when it is stored (so the
// profile shows tidy text) and reduced to a key when it is compared (so "bengaluru", "Bengaluru "
// and "BENGALURU" are one place). Pure.

/** The 249 officially assigned ISO 3166-1 alpha-2 codes. */
export const COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
    'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
    'DE DJ DK DM DO DZ ' +
    'EC EE EG EH ER ES ET ' +
    'FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
    'HK HM HN HR HT HU ' +
    'ID IE IL IM IN IO IQ IR IS IT ' +
    'JE JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KY KZ ' +
    'LA LB LC LI LK LR LS LT LU LV LY ' +
    'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
    'NA NC NE NF NG NI NL NO NP NR NU NZ ' +
    'OM ' +
    'PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
    'QA ' +
    'RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
    'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ ' +
    'VA VC VE VG VI VN VU ' +
    'WF WS ' +
    'YE YT ' +
    'ZA ZM ZW'
  )
    .split(' ')
    .filter(Boolean)
)

/** "in", " IN " -> "IN"; anything that is not an assigned code -> null. */
export function normalizeCountryCode(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const code = input.trim().toUpperCase()
  return COUNTRY_CODES.has(code) ? code : null
}

export const MAX_PLACE_LENGTH = 80

// Control characters and the zero-width and bidirectional marks that make two identical-looking names differ.
// Built from code points: some of them are line terminators and cannot sit in a regex literal.
const INVISIBLE_RANGES: [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
]
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu'
)

/**
 * Tidies free text: Unicode composed form, control characters dropped, runs of whitespace
 * collapsed to one space, ends trimmed, cut to MAX_PLACE_LENGTH. Empty text is null.
 */
export function normalizePlace(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const text = input
    .normalize('NFKC')
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PLACE_LENGTH)
    .trim()
  return text.length > 0 ? text : null
}

/**
 * What two spellings of one place have in common: lower case, accents removed, every run of
 * other characters a single hyphen. "São Paulo", "sao  paulo" and "SAO-PAULO" all become
 * "sao-paulo". Null for text with nothing left (for example only punctuation).
 */
export function placeKey(input: string | null | undefined): string | null {
  const text = normalizePlace(input)
  if (!text) return null
  const key = text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return key.length > 0 ? key : null
}
