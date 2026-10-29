import { describe, it, expect } from 'vitest'
import { canonicalHash, canonicalize, CanonicalJsonError } from './canonical'

describe('canonical JSON', () => {
  it('sorts object members by UTF-16 code units, at every depth, with no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, 2], c: true } })).toBe('{"a":{"c":true,"d":[3,2]},"b":1}')
    // Upper case sorts before lower case, and "é" (U+00E9) after every ASCII letter.
    expect(canonicalize({ é: 1, z: 2, Z: 3, a: 4 })).toBe('{"Z":3,"a":4,"z":2,"é":1}')
    // RFC 8785's own ordering example: by code unit, so U+20AC sorts before an astral character whose first surrogate is U+D83D, and U+FB33 after it.
    expect(Object.keys(JSON.parse(canonicalize({ 'דּ': 1, '€': 2, '😀': 3, '\r': 4, '1': 5 })))).toEqual(['1', '\r', '€', '😀', 'דּ'])
  })

  it('keeps arrays in their order, nested arrays included', () => {
    expect(canonicalize([[3, [2, 1]], [], [{ b: 0, a: 0 }]])).toBe('[[3,[2,1]],[],[{"a":0,"b":0}]]')
  })

  it('prints numbers the way ECMAScript does', () => {
    expect(canonicalize([0, -0, 1, -1.5, 1e21, 1e-7, 0.000001, 123456789012345680000, 4.5, 2 ** 53])).toBe('[0,0,1,-1.5,1e+21,1e-7,0.000001,123456789012345680000,4.5,9007199254740992]')
  })

  it('refuses what JSON cannot hold', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, () => 1, Symbol('s'), 1n, new Date(0), { a: undefined }, new Map()]) {
      expect(() => canonicalize(bad), String(bad)).toThrow(CanonicalJsonError)
    }
  })

  it('escapes strings as JSON does and leaves other characters as they are', () => {
    expect(canonicalize('a"b\\c\n\t\u0001\u001f€😀')).toBe('"a\\"b\\\\c\\n\\t\\u0001\\u001f€😀"')
    // A lone surrogate is escaped, not mangled.
    expect(canonicalize('\ud800')).toBe('"\\ud800"')
  })

  it('makes the same bytes for the same value whatever order it was built in, and a different hash for any change', () => {
    const one = { facts: { commits: 3, days: [['2026-01-01', 2]] }, id: 'x' }
    const two = { id: 'x', facts: { days: [['2026-01-01', 2]], commits: 3 } }
    expect(canonicalize(one)).toBe(canonicalize(two))
    expect(canonicalHash(one)).toBe(canonicalHash(two))
    expect(canonicalHash(one)).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalHash({ ...one, facts: { ...one.facts, commits: 4 } })).not.toBe(canonicalHash(one))
  })

  it('accepts an object without a prototype', () => {
    const bare = Object.create(null) as Record<string, number>
    bare.b = 2
    bare.a = 1
    expect(canonicalize(bare)).toBe('{"a":1,"b":2}')
  })
})
