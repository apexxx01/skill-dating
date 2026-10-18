import { describe, it, expect } from 'vitest'
import { GENDERS, SCOPES } from './config'
import { accepts, inboxAllows, mutuallyAccept, type FilterFacts } from './filters'

const person = (over: Partial<FilterFacts> = {}): FilterFacts => ({
  gender: 'WOMAN',
  interestedIn: ['MAN'],
  ageMin: 25,
  ageMax: 40,
  scope: 'ANYWHERE',
  age: 30,
  cityKey: 'pune',
  countryCode: 'IN',
  ...over,
})

describe('one direction', () => {
  it('needs the other gender to be among those the person is interested in', () => {
    const viewer = person({ interestedIn: ['MAN', 'NON_BINARY'] })
    expect(accepts(viewer, person({ gender: 'MAN' }))).toBeNull()
    expect(accepts(viewer, person({ gender: 'NON_BINARY' }))).toBeNull()
    expect(accepts(viewer, person({ gender: 'WOMAN' }))).toBe('GENDER')
    expect(accepts(viewer, person({ gender: 'SELF_DESCRIBED' }))).toBe('GENDER')
  })

  it('counts a self-described person only for somebody interested in that group', () => {
    expect(accepts(person({ interestedIn: ['SELF_DESCRIBED'] }), person({ gender: 'SELF_DESCRIBED' }))).toBeNull()
  })

  it('keeps the other person inside the age range, ends included', () => {
    const viewer = person({ interestedIn: ['MAN'], ageMin: 28, ageMax: 35 })
    const man = (age: number) => person({ gender: 'MAN', age })
    expect(accepts(viewer, man(27))).toBe('AGE')
    expect(accepts(viewer, man(28))).toBeNull()
    expect(accepts(viewer, man(35))).toBeNull()
    expect(accepts(viewer, man(36))).toBe('AGE')
  })

  it('needs the same city for CITY and the same country for COUNTRY, and a place on file', () => {
    const base = { interestedIn: ['MAN'] as const, ...{} }
    const other = (over: Partial<FilterFacts>) => person({ gender: 'MAN', ...over })
    const city = person({ ...base, scope: 'CITY' })
    expect(accepts(city, other({ cityKey: 'pune' }))).toBeNull()
    expect(accepts(city, other({ cityKey: 'mumbai' }))).toBe('SCOPE')
    expect(accepts(city, other({ cityKey: null }))).toBe('SCOPE')
    expect(accepts(person({ ...base, scope: 'CITY', cityKey: null }), other({ cityKey: null }))).toBe('SCOPE')
    const country = person({ ...base, scope: 'COUNTRY' })
    expect(accepts(country, other({ cityKey: 'delhi', countryCode: 'IN' }))).toBeNull()
    expect(accepts(country, other({ countryCode: 'DE' }))).toBe('SCOPE')
    expect(accepts(country, other({ countryCode: null }))).toBe('SCOPE')
    expect(accepts(person({ ...base, scope: 'ANYWHERE' }), other({ countryCode: 'DE', cityKey: null }))).toBeNull()
  })
})

describe('both directions (asymmetric cases)', () => {
  const woman = person({ gender: 'WOMAN', interestedIn: ['MAN'], ageMin: 25, ageMax: 40, age: 30 })

  it('refuses when only one side is interested in the other gender', () => {
    const man = person({ gender: 'MAN', interestedIn: ['MAN'], ageMin: 20, ageMax: 50, age: 30 })
    expect(accepts(woman, man)).toBeNull()
    expect(accepts(man, woman)).toBe('GENDER')
    expect(mutuallyAccept(woman, man)).toEqual({ ok: false, by: 'B', reason: 'GENDER' })
    expect(mutuallyAccept(man, woman)).toEqual({ ok: false, by: 'A', reason: 'GENDER' })
  })

  it('refuses when one side is inside the other range but not the other way round', () => {
    const youngerMan = person({ gender: 'MAN', interestedIn: ['WOMAN'], ageMin: 20, ageMax: 35, age: 24 })
    // She accepts 25 to 40 and he is 24; he accepts 20 to 35 and she is 30.
    expect(accepts(youngerMan, woman)).toBeNull()
    expect(accepts(woman, youngerMan)).toBe('AGE')
    expect(mutuallyAccept(woman, youngerMan)).toEqual({ ok: false, by: 'A', reason: 'AGE' })
    const olderMan = person({ gender: 'MAN', interestedIn: ['WOMAN'], ageMin: 20, ageMax: 28, age: 33 })
    // She accepts him (33 is inside 25 to 40); he does not accept her (30 is outside 20 to 28).
    expect(accepts(woman, olderMan)).toBeNull()
    expect(accepts(olderMan, woman)).toBe('AGE')
  })

  it('lets the stricter scope decide', () => {
    const here = person({ gender: 'MAN', interestedIn: ['WOMAN'], scope: 'ANYWHERE', cityKey: 'mumbai' })
    const picky = person({ scope: 'CITY', cityKey: 'pune' })
    expect(mutuallyAccept(picky, here)).toEqual({ ok: false, by: 'A', reason: 'SCOPE' })
    expect(mutuallyAccept(here, picky)).toEqual({ ok: false, by: 'B', reason: 'SCOPE' })
    const sameCity = person({ gender: 'MAN', interestedIn: ['WOMAN'], scope: 'ANYWHERE', cityKey: 'pune' })
    expect(mutuallyAccept(picky, sameCity)).toEqual({ ok: true })
  })

  it('accepts a fully compatible pair from either side', () => {
    const man = person({ gender: 'MAN', interestedIn: ['WOMAN'], ageMin: 25, ageMax: 35, age: 33 })
    expect(mutuallyAccept(woman, man)).toEqual({ ok: true })
    expect(mutuallyAccept(man, woman)).toEqual({ ok: true })
  })

  it('is symmetric over every gender and scope combination (swapping the two people swaps who said no, never whether)', () => {
    for (const g1 of GENDERS) {
      for (const g2 of GENDERS) {
        for (const s1 of SCOPES) {
          for (const s2 of SCOPES) {
            const a = person({ gender: g1, interestedIn: [g2], scope: s1, cityKey: 'pune' })
            const b = person({ gender: g2, interestedIn: [g1], scope: s2, cityKey: s1 === 'CITY' ? 'pune' : 'goa' })
            expect(mutuallyAccept(a, b).ok).toBe(mutuallyAccept(b, a).ok)
          }
        }
      }
    }
  })
})

describe('the inbox gate', () => {
  it('lets a sender through with at least the required number of endorsements', () => {
    expect(inboxAllows(0, 0)).toBe(true)
    expect(inboxAllows(3, 2)).toBe(false)
    expect(inboxAllows(3, 3)).toBe(true)
    expect(inboxAllows(5, 40)).toBe(true)
  })
})
