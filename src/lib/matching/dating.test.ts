import { describe, it, expect } from 'vitest'
import { adultBirthDateCutoff, ageOn, datingBlockers, datingEligibleSql, formatBirthDate, isDatingEligible, parseBirthDate, type DatingFacts } from './dating'

const d = (iso: string) => new Date(`${iso}T00:00:00Z`)
const adult: DatingFacts = { birthDate: d('1995-06-15'), isEmailVerified: true, isPhoneVerified: true, githubConnected: false }
const now = new Date('2026-10-16T12:00:00Z')

describe('ageOn', () => {
  it('counts whole years, turning over on the birthday itself', () => {
    expect(ageOn(d('2008-10-16'), d('2026-10-16'))).toBe(18)
    expect(ageOn(d('2008-10-17'), d('2026-10-16'))).toBe(17)
    expect(ageOn(d('2008-10-15'), d('2026-10-16'))).toBe(18)
    expect(ageOn(d('2008-11-01'), d('2026-10-16'))).toBe(17)
    expect(ageOn(d('1990-01-01'), d('2026-10-16'))).toBe(36)
    expect(ageOn(d('2026-10-16'), d('2026-10-16'))).toBe(0)
  })

  it('reaches a 29 February birthday on 1 March in a common year, and on the day in a leap year', () => {
    expect(ageOn(d('2008-02-29'), d('2026-02-28'))).toBe(17)
    expect(ageOn(d('2008-02-29'), d('2026-03-01'))).toBe(18)
    expect(ageOn(d('2008-02-29'), d('2028-02-29'))).toBe(20)
    expect(ageOn(d('2008-02-29'), d('2028-02-28'))).toBe(19)
  })

  it('uses the UTC date, whatever the time of day', () => {
    expect(ageOn(d('2008-10-16'), new Date('2026-10-16T00:00:00Z'))).toBe(18)
    expect(ageOn(d('2008-10-16'), new Date('2026-10-15T23:59:59Z'))).toBe(17)
  })
})

describe('datingBlockers', () => {
  it('is empty for a verified adult', () => {
    expect(datingBlockers(adult, now)).toEqual([])
    expect(isDatingEligible(adult, now)).toBe(true)
  })

  it('refuses a missing date of birth: no date, no dating', () => {
    expect(datingBlockers({ ...adult, birthDate: null }, now)).toEqual(['BIRTH_DATE_MISSING'])
  })

  it('refuses a minor, to the day', () => {
    expect(datingBlockers({ ...adult, birthDate: d('2008-10-17') }, now)).toEqual(['UNDER_AGE'])
    expect(datingBlockers({ ...adult, birthDate: d('2008-10-16') }, now)).toEqual([])
    expect(datingBlockers({ ...adult, birthDate: d('2015-01-01') }, now)).toEqual(['UNDER_AGE'])
    expect(datingBlockers({ ...adult, birthDate: d('2026-10-16') }, now)).toEqual(['UNDER_AGE'])
  })

  it('needs a verified email', () => {
    expect(datingBlockers({ ...adult, isEmailVerified: false }, now)).toEqual(['EMAIL_NOT_VERIFIED'])
  })

  it('needs a verified phone or a connected GitHub account, either one', () => {
    expect(datingBlockers({ ...adult, isPhoneVerified: false, githubConnected: false }, now)).toEqual(['NO_PHONE_OR_GITHUB'])
    expect(datingBlockers({ ...adult, isPhoneVerified: false, githubConnected: true }, now)).toEqual([])
    expect(datingBlockers({ ...adult, isPhoneVerified: true, githubConnected: true }, now)).toEqual([])
  })

  it('lists everything in the order to tell the person', () => {
    expect(datingBlockers({ birthDate: null, isEmailVerified: false, isPhoneVerified: false, githubConnected: false }, now)).toEqual([
      'BIRTH_DATE_MISSING',
      'EMAIL_NOT_VERIFIED',
      'NO_PHONE_OR_GITHUB',
    ])
    expect(datingBlockers({ birthDate: d('2012-01-01'), isEmailVerified: false, isPhoneVerified: true, githubConnected: false }, now)).toEqual(['UNDER_AGE', 'EMAIL_NOT_VERIFIED'])
  })

  it('never lets a verified account make up for a missing age', () => {
    const verified = { isEmailVerified: true, isPhoneVerified: true, githubConnected: true }
    expect(isDatingEligible({ ...verified, birthDate: null }, now)).toBe(false)
    expect(isDatingEligible({ ...verified, birthDate: d('2010-01-01') }, now)).toBe(false)
  })
})

describe('adultBirthDateCutoff', () => {
  it('is the same day 18 years ago', () => {
    expect(adultBirthDateCutoff(now)).toBe('2008-10-16')
    expect(adultBirthDateCutoff(new Date('2030-01-01T00:00:00Z'))).toBe('2012-01-01')
  })

  it('is 28 February for 29 February when 18 years earlier was a common year', () => {
    expect(adultBirthDateCutoff(new Date('2028-02-29T10:00:00Z'))).toBe('2010-02-28')
    expect(adultBirthDateCutoff(new Date('2032-02-29T10:00:00Z'))).toBe('2014-02-28')
  })

  it('agrees with ageOn for every day around a birthday, across leap years', () => {
    const start = Date.UTC(2025, 0, 1)
    for (let offset = 0; offset < 4 * 366; offset++) {
      const today = new Date(start + offset * 86_400_000)
      const cutoff = adultBirthDateCutoff(today)
      for (const delta of [-2, -1, 0, 1, 2]) {
        const born = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate() + delta))
        const bornKey = formatBirthDate(born)
        expect(bornKey <= cutoff, `${bornKey} on ${formatBirthDate(today)}`).toBe(ageOn(born, today) >= 18)
      }
    }
  })
})

describe('datingEligibleSql', () => {
  it('is the same rule in SQL, with the cutoff as a parameter', () => {
    const sql = datingEligibleSql('u', now)
    expect(sql.sql).toContain('"u"."isEmailVerified"')
    expect(sql.sql).toContain('"u"."isPhoneVerified"')
    expect(sql.sql).toContain('"u"."githubConnected"')
    expect(sql.sql).toContain('"u"."birthDate" IS NOT NULL')
    expect(sql.values).toEqual(['2008-10-16'])
  })

  it('cannot be used to inject through the alias', () => {
    const sql = datingEligibleSql('u"; DROP TABLE "User"; --', now).sql
    expect(sql).not.toMatch(/[;]|--/)
    expect(sql.startsWith('("uDROPTABLEUser"."isEmailVerified"')).toBe(true)
  })
})

describe('parseBirthDate', () => {
  it('reads a real calendar date', () => {
    expect(parseBirthDate('1995-06-15', now)).toEqual(d('1995-06-15'))
    expect(parseBirthDate('2000-02-29', now)).toEqual(d('2000-02-29'))
  })

  it('refuses what is not a date, a date that does not exist, the future and the distant past', () => {
    for (const bad of ['', 'yesterday', '1995-6-15', '1995-13-01', '1995-02-30', '2001-02-29', '2026-10-17', '2099-01-01', '1899-12-31', '1995-06-15T00:00:00Z', ' 1995-06-15']) {
      expect(parseBirthDate(bad, now), bad).toBeNull()
    }
  })

  it('accepts today and the first allowed day', () => {
    expect(parseBirthDate('2026-10-16', now)).not.toBeNull()
    expect(parseBirthDate('1900-01-01', now)).not.toBeNull()
  })

  it('round-trips with formatBirthDate', () => {
    expect(formatBirthDate(d('1995-06-05'))).toBe('1995-06-05')
    expect(formatBirthDate(parseBirthDate('1900-01-01', now)!)).toBe('1900-01-01')
  })
})
