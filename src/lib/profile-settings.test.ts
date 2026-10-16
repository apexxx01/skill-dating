import { describe, it, expect } from 'vitest'
import { profileColumns, profileSettingsSchema } from './profile-settings'

const parse = (value: unknown) => profileSettingsSchema.safeParse(value)

describe('profileSettingsSchema', () => {
  it('accepts any one field, or all of them', () => {
    expect(parse({ timezone: 'Asia/Kolkata' }).success).toBe(true)
    expect(parse({ countryCode: 'in' }).success).toBe(true)
    expect(parse({ city: 'Pune', campus: 'COEP', hideFromLeaderboards: true, showActivity: false, timezone: null, countryCode: null }).success).toBe(true)
  })

  it('refuses an empty body and unknown fields', () => {
    expect(parse({}).success).toBe(false)
    expect(parse({ role: 'ADMIN' }).success).toBe(false)
    expect(parse({ city: 'Pune', xp: 100000 }).success).toBe(false)
  })

  it('validates the time zone and the country', () => {
    expect(parse({ timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(parse({ timezone: '' }).success).toBe(false)
    expect(parse({ countryCode: 'XX' }).success).toBe(false)
    expect(parse({ countryCode: 'India' }).success).toBe(false)
    expect(parse({ countryCode: ' gb ' }).success).toBe(true)
  })

  it('checks the types of the switches and the length of the text', () => {
    expect(parse({ hideFromLeaderboards: 'yes' }).success).toBe(false)
    expect(parse({ showActivity: 0 }).success).toBe(false)
    expect(parse({ city: 'x'.repeat(201) }).success).toBe(false)
    expect(parse({ campus: 42 }).success).toBe(false)
  })
})

describe('profileColumns', () => {
  it('stores tidied text with its comparable key, and an upper-case country', () => {
    expect(profileColumns({ countryCode: ' in ', city: '  Bengaluru  ', campus: 'IISc   Bangalore' })).toEqual({
      countryCode: 'IN',
      city: 'Bengaluru',
      cityKey: 'bengaluru',
      campus: 'IISc Bangalore',
      campusKey: 'iisc-bangalore',
    })
  })

  it('clears a field that is sent as null, its key included', () => {
    expect(profileColumns({ countryCode: null, city: null, campus: '   ' })).toEqual({
      countryCode: null,
      city: null,
      cityKey: null,
      campus: null,
      campusKey: null,
    })
  })

  it('leaves out what was not sent', () => {
    expect(profileColumns({ hideFromLeaderboards: true })).toEqual({ hideFromLeaderboards: true })
    expect(profileColumns({ timezone: 'UTC' })).toEqual({})
  })
})
