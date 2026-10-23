import { describe, it, expect } from 'vitest'
import { ageBandOf, cardsAllowed, isMinor, adultCutoff, platformCutoff, recruiterVisible } from './age-policy'
import { ageOn, birthDateCutoffForAge } from './age'

const at = (iso: string) => new Date(`${iso}T12:00:00Z`)
const born = (iso: string) => new Date(`${iso}T00:00:00Z`)

describe('age bands', () => {
  const now = at('2026-10-18')

  it('refuses under 16, marks 16 and 17 as minors and 18 and over as adults', () => {
    expect(ageBandOf(born('2011-10-19'), now)).toBe('UNDER_MINIMUM') // 14
    expect(ageBandOf(born('2010-10-19'), now)).toBe('UNDER_MINIMUM') // 15, sixteenth birthday tomorrow
    expect(ageBandOf(born('2010-10-18'), now)).toBe('MINOR') // 16 today
    expect(ageBandOf(born('2009-10-19'), now)).toBe('MINOR') // 16, seventeenth birthday tomorrow
    expect(ageBandOf(born('2009-10-18'), now)).toBe('MINOR') // 17 today
    expect(ageBandOf(born('2008-10-19'), now)).toBe('MINOR') // 17, eighteenth tomorrow
    expect(ageBandOf(born('2008-10-18'), now)).toBe('ADULT') // 18 today
    expect(ageBandOf(born('1990-01-01'), now)).toBe('ADULT')
  })

  it('stops being a minor on the eighteenth birthday without anything being updated', () => {
    const dob = born('2008-10-20')
    expect(isMinor(dob, at('2026-10-19'))).toBe(true)
    expect(isMinor(dob, at('2026-10-20'))).toBe(false)
  })

  it('does not take somebody with no date on file for a minor', () => {
    expect(isMinor(null)).toBe(false)
    expect(isMinor(undefined)).toBe(false)
  })

  it('handles a 29 February birthday: reached on 1 March in a common year', () => {
    const leap = born('2008-02-29')
    expect(ageOn(leap, at('2026-02-28'))).toBe(17)
    expect(ageOn(leap, at('2026-03-01'))).toBe(18)
    expect(ageBandOf(leap, at('2026-02-28'))).toBe('MINOR')
    expect(ageBandOf(leap, at('2026-03-01'))).toBe('ADULT')
  })
})

describe('recruiter visibility', () => {
  const now = at('2026-10-18')

  it('is for adults only: never a minor, never somebody whose age is not on file', () => {
    expect(recruiterVisible(born('1990-01-01'), now)).toBe(true)
    expect(recruiterVisible(born('2008-10-18'), now)).toBe(true)
    expect(recruiterVisible(born('2008-10-19'), now)).toBe(false)
    expect(recruiterVisible(born('2010-10-18'), now)).toBe(false)
    expect(recruiterVisible(null, now)).toBe(false)
    expect(recruiterVisible(undefined, now)).toBe(false)
  })
})

describe('cutoffs agree with ageOn for every day of a year', () => {
  it('born on or before the cutoff <=> at least that age', () => {
    for (let offset = 0; offset < 366 * 2; offset++) {
      const now = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000)
      for (const age of [16, 18]) {
        const cutoff = birthDateCutoffForAge(age, now)
        for (const dob of [born(cutoff), new Date(born(cutoff).getTime() + 86_400_000), new Date(born(cutoff).getTime() - 86_400_000)]) {
          const expected = ageOn(dob, now) >= age
          const byCutoff = dob.getTime() <= born(cutoff).getTime()
          expect(byCutoff, `${dob.toISOString()} on ${now.toISOString()} at ${age}`).toBe(expected)
        }
      }
    }
  })

  it('names the cutoffs for SQL', () => {
    expect(adultCutoff(at('2026-10-18'))).toBe('2008-10-18')
    expect(platformCutoff(at('2026-10-18'))).toBe('2010-10-18')
  })
})

describe('cardsAllowed', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  it('is for adults whose age is on file, and nobody else', () => {
    expect(cardsAllowed(new Date('1990-01-01T00:00:00Z'), now)).toBe(true)
    expect(cardsAllowed(new Date('2008-10-23T00:00:00Z'), now)).toBe(true) // 18 today
    expect(cardsAllowed(new Date('2008-10-24T00:00:00Z'), now)).toBe(false) // 17, until tomorrow
    expect(cardsAllowed(new Date('2010-01-01T00:00:00Z'), now)).toBe(false) // 16
    expect(cardsAllowed(new Date('2015-01-01T00:00:00Z'), now)).toBe(false) // under the minimum
    expect(cardsAllowed(null, now)).toBe(false)
    expect(cardsAllowed(undefined, now)).toBe(false)
  })
})
