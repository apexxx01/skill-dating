import { describe, it, expect } from 'vitest'
import { areConfusable, mixesScripts, skeleton } from './confusables'
import { isAllowedDisplayName, isReservedName, usernameRefusal } from './usernames'

describe('skeleton', () => {
  it("folds letter pairs that pass for one letter: 'rn' and 'm', 'vv' and 'w', 'cl' and 'd'", () => {
    expect(areConfusable('rnark', 'mark')).toBe(true)
    expect(areConfusable('vvalter', 'walter')).toBe(true)
    expect(areConfusable('clave', 'dave')).toBe(true)
  })

  it('folds digits and symbols that pass for letters, and i and l', () => {
    expect(areConfusable('paypa1', 'paypal')).toBe(true)
    expect(areConfusable('g00gle', 'google')).toBe(true)
    expect(areConfusable('adm1n', 'admin')).toBe(true)
    expect(areConfusable('b1ll', 'bill')).toBe(true)
  })

  it('folds Cyrillic and Greek look-alikes into Latin', () => {
    expect(areConfusable('аdmin', 'admin')).toBe(true) // Cyrillic а
    expect(areConfusable('ѕupport', 'support')).toBe(true) // Cyrillic ѕ
    expect(areConfusable('Αpple', 'apple')).toBe(true) // Greek Alpha
    expect(areConfusable('mоdеrаtоr', 'moderator')).toBe(true)
  })

  it('ignores case, accents and separators', () => {
    expect(areConfusable('Mark_Smith', 'marksmith')).toBe(true)
    expect(areConfusable('josé', 'jose')).toBe(true)
    expect(areConfusable('a.d-m_i n', 'admin')).toBe(true)
  })

  it('keeps names that read differently apart', () => {
    expect(areConfusable('mark', 'mike')).toBe(false)
    expect(areConfusable('anna', 'anne')).toBe(false)
    expect(skeleton('builder42')).toBe('bulldera2')
  })
})

describe('mixesScripts', () => {
  it('spots Latin mixed with Cyrillic or Greek', () => {
    expect(mixesScripts('аdmin')).toBe(true)
    expect(mixesScripts('admin')).toBe(false)
    expect(mixesScripts('Дмитрий')).toBe(false)
  })
})

describe('reserved names', () => {
  it('reserves staff, brand and route names and their look-alikes', () => {
    for (const name of ['admin', 'Admin', 'adm1n', 'аdmin', 'support', 'moderator', 'skilldating', 'skill_dating', 'dashboard', 'api', 'github', 'g1thub']) {
      expect(isReservedName(name)).toBe(true)
    }
    expect(isReservedName('ada_lovelace')).toBe(false)
  })

  it('refuses a reserved name, and a look-alike of a name somebody else holds', async () => {
    const holders = new Map([[skeleton('mark'), 'u-mark']])
    const holderOf = async (s: string) => holders.get(s) ?? null
    expect(await usernameRefusal('admin', holderOf)).toBe('RESERVED')
    expect(await usernameRefusal('rnark', holderOf)).toBe('CONFUSABLE')
    expect(await usernameRefusal('rnark', holderOf, 'u-mark')).toBeNull()
    expect(await usernameRefusal('mike', holderOf)).toBeNull()
  })

  it('refuses a display name that reads as a reserved name', () => {
    expect(isAllowedDisplayName('Ѕupport')).toBe(false)
    expect(isAllowedDisplayName('Admin')).toBe(false)
    expect(isAllowedDisplayName('Ada Lovelace')).toBe(true)
  })
})
