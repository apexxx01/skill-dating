import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { suppressionKey } from './settings'

describe('suppressionKey', () => {
  it('is the SHA-256 of the trimmed, lower-cased address, as 64 hex characters', () => {
    const key = suppressionKey('  Ada.Lovelace@Example.COM ')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).toBe(createHash('sha256').update('ada.lovelace@example.com').digest('hex'))
  })

  it('is the same for the same mailbox however it is written, and different for another', () => {
    expect(suppressionKey('A@B.dev')).toBe(suppressionKey('a@b.dev '))
    expect(suppressionKey('a@b.dev')).not.toBe(suppressionKey('a+x@b.dev'))
  })

  it('does not contain the address', () => {
    expect(suppressionKey('someone@example.com')).not.toContain('someone')
  })
})
