import { describe, it, expect } from 'vitest'
import { ADULT_NOTICE_GRACE_DAYS, adultBirthdayOf, adultNoticeDue, adultNoticeWindow, ageBandOf, cardsAllowed, isMinor, adultCutoff, platformCutoff, recruiterVisible, wasMinorAt } from './age-policy'
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

describe('having been a minor', () => {
  it('is true for an account made before the 18th birthday, even if the person is an adult now', () => {
    const dob = born('2008-10-23')
    expect(wasMinorAt(dob, at('2026-10-22'))).toBe(true) // the day before the 18th birthday
    expect(wasMinorAt(dob, at('2026-10-23'))).toBe(false) // on it
    expect(wasMinorAt(dob, at('2020-01-01'))).toBe(true)
  })

  it('says nothing about somebody with no date of birth', () => {
    expect(wasMinorAt(null, at('2026-10-23'))).toBe(false)
    expect(wasMinorAt(undefined, at('2026-10-23'))).toBe(false)
  })
})

describe('the 18th birthday', () => {
  it('is the date 18 years after, with 29 February reached on 1 March in a common year', () => {
    expect(adultBirthdayOf(born('2008-10-23'))).toBe('2026-10-23')
    expect(adultBirthdayOf(born('2008-02-29'))).toBe('2026-03-01')
    expect(adultBirthdayOf(born('2004-02-29'))).toBe('2022-03-01')
    // An ordinary date is the same date 18 years on, in a leap year too.
    expect(adultBirthdayOf(born('2010-02-28'))).toBe('2028-02-28')
  })

  it('agrees with ageOn on the day it arrives', () => {
    for (const iso of ['2008-10-23', '2008-02-29', '2008-12-31', '2008-01-01']) {
      const dob = born(iso)
      const birthday = adultBirthdayOf(dob)
      expect(ageOn(dob, new Date(`${birthday}T00:00:00Z`)), iso).toBe(18)
      expect(ageOn(dob, new Date(new Date(`${birthday}T00:00:00Z`).getTime() - 1)), iso).toBe(17)
    }
  })
})

describe('when the note about the cards is due', () => {
  const dob = born('2008-10-23') // 18 on 2026-10-23

  it('is not due the day before, in any zone', () => {
    const now = new Date('2026-10-22T23:59:00Z')
    expect(adultNoticeDue(dob, 'UTC', now)).toBe(false)
    expect(adultNoticeDue(dob, 'Pacific/Kiritimati', now)).toBe(false) // already the 23rd there, but not yet in UTC
  })

  it('waits for the birthday on the person’s own calendar: later in the west, and not before the UTC birthday in the east', () => {
    // 2026-10-23T03:00Z is the 23rd in UTC and Berlin, still the 22nd in New York and San Francisco.
    const early = new Date('2026-10-23T03:00:00Z')
    expect(adultNoticeDue(dob, 'UTC', early)).toBe(true)
    expect(adultNoticeDue(dob, 'Europe/Berlin', early)).toBe(true)
    expect(adultNoticeDue(dob, 'America/New_York', early)).toBe(false)
    expect(adultNoticeDue(dob, 'America/Los_Angeles', early)).toBe(false)
    // 04:00Z on the 23rd is midnight in New York (EDT) and 21:00 on the 22nd in Los Angeles.
    expect(adultNoticeDue(dob, 'America/New_York', new Date('2026-10-23T04:00:00Z'))).toBe(true)
    expect(adultNoticeDue(dob, 'America/Los_Angeles', new Date('2026-10-23T06:59:00Z'))).toBe(false)
    expect(adultNoticeDue(dob, 'America/Los_Angeles', new Date('2026-10-23T07:00:00Z'))).toBe(true)
  })

  it('does not run ahead of the UTC calendar the age policy counts in', () => {
    // 18:00Z on the 22nd is already the 23rd in Auckland, but the switch would still refuse for another six hours.
    const now = new Date('2026-10-22T18:00:00Z')
    expect(localDateKeyOf(now, 'Pacific/Auckland')).toBe('2026-10-23')
    expect(adultNoticeDue(dob, 'Pacific/Auckland', now)).toBe(false)
    expect(adultNoticeDue(dob, 'Pacific/Auckland', new Date('2026-10-23T00:00:00Z'))).toBe(true)
  })

  it('catches up for a week after a missed day, and then stops', () => {
    expect(adultNoticeDue(dob, 'UTC', new Date(`2026-10-${23 + ADULT_NOTICE_GRACE_DAYS}T12:00:00Z`))).toBe(true)
    expect(adultNoticeDue(dob, 'UTC', new Date(`2026-10-${23 + ADULT_NOTICE_GRACE_DAYS + 1}T12:00:00Z`))).toBe(false)
  })

  it('falls back to UTC for a person with no time zone', () => {
    expect(adultNoticeDue(dob, null, new Date('2026-10-23T00:30:00Z'))).toBe(true)
  })

  it('looks for the people who can be due with a window of birth dates that holds every one of them', () => {
    const now = new Date('2026-10-23T12:00:00Z')
    const { from, to } = adultNoticeWindow(now)
    expect(from <= '2008-10-14').toBe(true)
    expect(to >= '2008-10-24').toBe(true)
    expect(from > '2008-01-01' && to < '2009-01-01').toBe(true)
    for (const iso of ['2008-10-16', '2008-10-23', '2008-10-24']) expect(iso >= from && iso <= to, iso).toBe(true)
    expect(adultNoticeDue(born('2008-10-24'), 'Pacific/Kiritimati', now)).toBe(false) // but the 24th is not due yet: the zone check decides, the window only narrows the query
  })
})

function localDateKeyOf(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
}
