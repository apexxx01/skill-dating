import { describe, it, expect } from 'vitest'
import { utcTimestamp } from './sql'

describe('utcTimestamp', () => {
  it('binds the date as a parameter and converts it to a zone-less UTC timestamp', () => {
    const at = new Date('2026-10-16T10:00:00Z')
    const sql = utcTimestamp(at)
    expect(sql.sql).toContain('AT TIME ZONE')
    expect(sql.sql).toContain('::timestamptz')
    expect(sql.values).toEqual([at])
  })
})
