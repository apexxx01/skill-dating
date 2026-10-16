import { describe, it, expect } from 'vitest'
import { COUNTRY_CODES, MAX_PLACE_LENGTH, normalizeCountryCode, normalizePlace, placeKey } from './places'

describe('country codes', () => {
  it('has the 249 assigned ISO 3166-1 alpha-2 codes, each two capital letters', () => {
    expect(COUNTRY_CODES.size).toBe(249)
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/)
  })

  it('knows the countries builders come from', () => {
    for (const code of ['IN', 'US', 'GB', 'DE', 'BR', 'NG', 'SG', 'JP', 'KE', 'AU', 'CA', 'FR', 'ID', 'PK', 'PH', 'VN', 'TR', 'UA', 'PL', 'CN', 'ZA']) {
      expect(COUNTRY_CODES.has(code), code).toBe(true)
    }
  })

  it('accepts case and padding, and refuses what is not assigned', () => {
    expect(normalizeCountryCode('in')).toBe('IN')
    expect(normalizeCountryCode(' gb ')).toBe('GB')
    expect(normalizeCountryCode('XX')).toBeNull()
    expect(normalizeCountryCode('AA')).toBeNull()
    expect(normalizeCountryCode('USA')).toBeNull()
    expect(normalizeCountryCode('I')).toBeNull()
    expect(normalizeCountryCode('')).toBeNull()
    expect(normalizeCountryCode(null)).toBeNull()
    expect(normalizeCountryCode(undefined)).toBeNull()
    expect(normalizeCountryCode('1N')).toBeNull()
  })
})

describe('normalizePlace', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizePlace('  New   York \t City ')).toBe('New York City')
    expect(normalizePlace('Pune')).toBe('Pune')
  })

  it('drops control and invisible characters', () => {
    expect(normalizePlace('Ban\u0000gal​ore')).toBe('Ban gal ore')
    expect(normalizePlace('\u0007\u0008')).toBeNull()
  })

  it('composes accents and folds compatibility forms', () => {
    expect(normalizePlace('São Paulo')).toBe('São Paulo')
    expect(normalizePlace('ＭＩＴ')).toBe('MIT')
  })

  it('is null for nothing, and cut to the maximum length', () => {
    expect(normalizePlace('')).toBeNull()
    expect(normalizePlace('   ')).toBeNull()
    expect(normalizePlace(null)).toBeNull()
    expect(normalizePlace(undefined)).toBeNull()
    expect(normalizePlace('a'.repeat(500))).toHaveLength(MAX_PLACE_LENGTH)
  })
})

describe('placeKey', () => {
  it('makes spellings of one place equal', () => {
    const keys = ['Bengaluru', ' bengaluru ', 'BENGALURU'].map(placeKey)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('bengaluru')
    expect(placeKey('São Paulo')).toBe('sao-paulo')
    expect(placeKey('sao  paulo')).toBe('sao-paulo')
    expect(placeKey('SAO-PAULO')).toBe('sao-paulo')
    expect(placeKey("St. John's")).toBe('st-john-s')
  })

  it('keeps non-latin names and tells different places apart', () => {
    expect(placeKey('東京')).toBe('東京')
    expect(placeKey('Delhi')).not.toBe(placeKey('New Delhi'))
  })

  it('is null when nothing letter-like is left', () => {
    expect(placeKey('---')).toBeNull()
    expect(placeKey('!!!')).toBeNull()
    expect(placeKey('')).toBeNull()
    expect(placeKey(null)).toBeNull()
  })

  it('never contains anything that could break a cache key', () => {
    const key = placeKey('a:b/c d*e?f')!
    expect(key).toMatch(/^[\p{L}\p{N}-]+$/u)
  })
})
