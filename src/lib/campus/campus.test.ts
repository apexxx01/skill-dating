import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/env', () => ({ env: { NOTIFICATION_SIGNING_SECRET: 'a-test-secret-that-is-at-least-thirty-two-chars', CLERK_SECRET_KEY: 'sk_test_x' } }))

import { campusColumns, campusSlug, codeHashOf, CODE_LENGTH, emailHashOf, emailOnDomains, newCode, normalizeDomain, normalizeDomains, normalizeEmail } from './campus'

describe('domains and addresses', () => {
  it('tidies a domain', () => {
    expect(normalizeDomain(' @IISc.ac.in. ')).toBe('iisc.ac.in')
    expect(normalizeDomain('cs.iisc.ac.in')).toBe('cs.iisc.ac.in')
  })

  it('refuses what is not a domain', () => {
    for (const bad of ['', 'localhost', 'iisc', 'a b.com', 'https://iisc.ac.in', '-bad.com', 'bad-.com', 'a..b.com', 'x'.repeat(260) + '.com']) expect(normalizeDomain(bad), bad).toBeNull()
  })

  it('needs every domain of a list to be one, and drops repeats', () => {
    expect(normalizeDomains(['IISC.ac.in', 'iisc.ac.in', 'iisc.ernet.in'])).toEqual(['iisc.ac.in', 'iisc.ernet.in'])
    expect(normalizeDomains(['iisc.ac.in', 'nonsense'])).toBeNull()
  })

  it('tidies an address and refuses one that is not', () => {
    expect(normalizeEmail('  Ada@IISc.ac.in ')).toBe('ada@iisc.ac.in')
    for (const bad of ['', 'ada', 'ada@', '@iisc.ac.in', 'a@b@iisc.ac.in', 'ada @iisc.ac.in', 'ada@localhost']) expect(normalizeEmail(bad), bad).toBeNull()
  })

  it('matches the campus domain and its subdomains, and nothing that merely ends the same way', () => {
    const domains = ['iisc.ac.in']
    expect(emailOnDomains('ada@iisc.ac.in', domains)).toBe(true)
    expect(emailOnDomains('Ada@CS.IISc.ac.in', domains)).toBe(true)
    expect(emailOnDomains('ada@eviliisc.ac.in', domains)).toBe(false)
    expect(emailOnDomains('ada@iisc.ac.in.evil.com', domains)).toBe(false)
    expect(emailOnDomains('ada@gmail.com', domains)).toBe(false)
    expect(emailOnDomains('not-an-address', domains)).toBe(false)
  })
})

describe('campusSlug', () => {
  it('is the key places use: lower case words joined by hyphens', () => {
    expect(campusSlug('IISc Bangalore')).toBe('iisc-bangalore')
    expect(campusSlug('  UT   Austin ')).toBe('ut-austin')
    expect(campusSlug('!!!')).toBeNull()
  })
})

describe('the hashes and the code', () => {
  it('hashes an address the same way every time, differently per address, and not to the address', () => {
    expect(emailHashOf('ada@iisc.ac.in')).toBe(emailHashOf('ada@iisc.ac.in'))
    expect(emailHashOf('ada@iisc.ac.in')).not.toBe(emailHashOf('grace@iisc.ac.in'))
    expect(emailHashOf('ada@iisc.ac.in')).toMatch(/^[0-9a-f]{64}$/)
    expect(emailHashOf('ada@iisc.ac.in')).not.toContain('ada')
  })

  it('ties a code to the person it was made for', () => {
    expect(codeHashOf('u1', '123456')).toBe(codeHashOf('u1', '123456'))
    expect(codeHashOf('u1', '123456')).not.toBe(codeHashOf('u2', '123456'))
    expect(codeHashOf('u1', '123456')).not.toBe(codeHashOf('u1', '123457'))
    expect(codeHashOf('u1', '123456')).not.toBe(emailHashOf('u1:123456'))
  })

  it('makes six digits, with leading zeros kept', () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`))
  })
})

describe('campusColumns', () => {
  it('turns input into columns, and says which field is wrong', () => {
    expect(campusColumns({ name: '  IISc   Bangalore ', emailDomains: ['IISC.ac.in'], city: 'Bengaluru', countryCode: 'in' })).toEqual({
      ok: true,
      data: { name: 'IISc Bangalore', emailDomains: ['iisc.ac.in'], city: 'Bengaluru', cityKey: 'bengaluru', countryCode: 'IN' },
    })
    expect(campusColumns({ emailDomains: ['nope'] })).toMatchObject({ ok: false, field: 'emailDomains' })
    expect(campusColumns({ countryCode: 'ZZ' })).toMatchObject({ ok: false, field: 'countryCode' })
    expect(campusColumns({ name: '   ' })).toMatchObject({ ok: false, field: 'name' })
    expect(campusColumns({ city: null, countryCode: null })).toEqual({ ok: true, data: { city: null, cityKey: null, countryCode: null } })
    expect(campusColumns({})).toEqual({ ok: true, data: {} })
  })
})
