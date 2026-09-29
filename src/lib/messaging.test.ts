import { describe, it, expect } from 'vitest'
import { isValidEmoji } from './messaging'

describe('isValidEmoji', () => {
  it.each(['👍', '❤️', '👨‍👩‍👧', '🇺🇸', '1️⃣', '👍🏽'])('accepts %s', (value) => {
    expect(isValidEmoji(value)).toBe(true)
  })

  it.each(['', 'hello', '1', '😀a', '😀 ', 'a\u0000😀', '<b>', '👍'.repeat(9), '‍'])(
    'rejects %j',
    (value) => {
      expect(isValidEmoji(value)).toBe(false)
    }
  )
})
