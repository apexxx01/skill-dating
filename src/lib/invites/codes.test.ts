import { describe, it, expect } from 'vitest'
import { canonicalEmail, CODE_ALPHABET, CODE_LENGTH, generateCode, normalizeCode } from './codes'

describe('generateCode', () => {
  it('makes eight characters from an alphabet without look-alikes, and rarely the same twice', () => {
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const code = generateCode()
      expect(code).toHaveLength(CODE_LENGTH)
      expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]+$`))
      seen.add(code)
    }
    expect(seen.size).toBe(500)
  })
})

describe('normalizeCode', () => {
  it('upper-cases and drops spaces and hyphens', () => {
    expect(normalizeCode('k7m2-qx9d')).toBe('K7M2QX9D')
    expect(normalizeCode(' k7m2 qx9d ')).toBe('K7M2QX9D')
    expect(normalizeCode('iisc2026')).toBe('IISC2026')
  })

  it('refuses what cannot be a code', () => {
    for (const bad of ['', 'abc', 'a'.repeat(33), 'k7m2_qx9d', 'k7m2!qx9d', '<script>']) expect(normalizeCode(bad), bad).toBeNull()
  })
})

describe('canonicalEmail', () => {
  it('folds the +tag of any address and the dots and googlemail alias of a Gmail one', () => {
    expect(canonicalEmail('Ada.Lovelace+invite@Gmail.com')).toBe('adalovelace@gmail.com')
    expect(canonicalEmail('a.d.a@googlemail.com')).toBe('ada@gmail.com')
    expect(canonicalEmail('ada.lovelace+x@example.com')).toBe('ada.lovelace@example.com')
  })

  it('treats two spellings of one mailbox as the same, and two mailboxes as different', () => {
    expect(canonicalEmail('ada@gmail.com')).toBe(canonicalEmail('A.D.A+two@gmail.com'))
    expect(canonicalEmail('ada@example.com')).not.toBe(canonicalEmail('a.da@example.com'))
    expect(canonicalEmail('ada@gmail.com')).not.toBe(canonicalEmail('ada@example.com'))
  })

  it('leaves something that is not an address as it is', () => {
    expect(canonicalEmail(' Not An Address ')).toBe('not an address')
  })
})
