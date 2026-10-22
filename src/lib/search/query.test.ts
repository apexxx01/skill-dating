import { describe, it, expect } from 'vitest'
import { foldText, isSearchable, likePrefix, parseTypes, prefixTsQuery, tidyQuery } from './query'
import { decodeCursor, encodeCursor } from './types'

describe('tidyQuery', () => {
  it('lower-cases, drops accents and punctuation, and keeps the words', () => {
    expect(tidyQuery('  Grace   HOPPER!! ')).toEqual({ text: 'grace hopper', words: ['grace', 'hopper'] })
    expect(tidyQuery('José Ünal-Çelik').words).toEqual(['jose', 'unal', 'celik'])
    expect(tidyQuery('Ｇｒａｃｅ').text).toBe('grace')
  })

  it('keeps letters of every script, digits and underscores', () => {
    expect(tidyQuery('日本語 エンジニア').words).toEqual(['日本語', 'エンジニア'])
    expect(tidyQuery('ресурс_2').words).toEqual(['ресурс_2'])
    // Marks that are part of a letter stay: a Devanagari vowel sign, a Japanese voicing mark.
    expect(tidyQuery('हिन्दी इंजीनियर').words).toEqual(['हिन्दी', 'इंजीनियर'])
    expect(tidyQuery('ジ').text).toBe('ジ')
    expect(tidyQuery('c++ / node.js').words).toEqual(['c', 'node', 'js'])
  })

  it('cuts it to eight words of forty characters', () => {
    expect(tidyQuery('a b c d e f g h i j').words).toHaveLength(8)
    expect(tidyQuery('x'.repeat(200)).words[0]).toHaveLength(40)
  })

  it('leaves nothing for syntax: operators, quotes and tsquery characters are gone', () => {
    for (const hostile of [`a' OR 1=1 --`, 'a:* | b', '!(a)', '"a" <-> "b"', 'a\\b%c']) {
      const { words } = tidyQuery(hostile)
      for (const word of words) expect(word).toMatch(/^[\p{L}\p{N}\p{M}_]+$/u)
    }
  })

  it('is empty for text with no letters or digits', () => {
    expect(tidyQuery('!!! ???')).toEqual({ text: '', words: [] })
  })
})

describe('isSearchable', () => {
  it('needs two letters or digits', () => {
    expect(isSearchable(tidyQuery('a'))).toBe(false)
    expect(isSearchable(tidyQuery('ab'))).toBe(true)
    expect(isSearchable(tidyQuery('a b'))).toBe(true)
    expect(isSearchable(tidyQuery(''))).toBe(false)
  })
})

describe('prefixTsQuery and likePrefix', () => {
  it('makes every word a required prefix', () => {
    expect(prefixTsQuery(['gra', 'hop'])).toBe('gra:* & hop:*')
    expect(prefixTsQuery(['a'])).toBe('a:*')
  })

  it('escapes what LIKE treats specially', () => {
    expect(likePrefix('grace hopper')).toBe('grace hopper%')
    expect(likePrefix('a_b')).toBe('a\\_b%')
    expect(likePrefix('50%')).toBe('50\\%%')
  })
})

describe('parseTypes', () => {
  it('defaults to all five, and accepts any subset once each', () => {
    expect(parseTypes(undefined)).toEqual(['users', 'projects', 'crews', 'hackathons', 'posts'])
    expect(parseTypes('')).toEqual(['users', 'projects', 'crews', 'hackathons', 'posts'])
    expect(parseTypes('Users, posts,users')).toEqual(['users', 'posts'])
  })

  it('refuses a name it does not know', () => {
    expect(parseTypes('users,romance')).toBeNull()
    expect(parseTypes(',')).toBeNull()
  })
})

describe('foldText', () => {
  it('removes accents and folds compatibility forms', () => {
    expect(foldText('Crème Brûlée ﬁ')).toBe('creme brulee fi')
  })
})

describe('the cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor({ score: 0.9234, type: 'crews', id: 'abc' }))).toEqual({ score: 0.9234, type: 'crews', id: 'abc' })
  })

  it('refuses anything else', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    for (const junk of ['', 'x', encode({}), encode({ v: 2, s: 1, t: 'users', i: 'a' }), encode({ v: 1, s: -1, t: 'users', i: 'a' }), encode({ v: 1, s: 1, t: 'romance', i: 'a' }), encode({ v: 1, s: 1, t: 'users', i: '' }), encode({ v: 1, s: 'x', t: 'users', i: 'a' })]) {
      expect(decodeCursor(junk), junk).toBeNull()
    }
  })
})
