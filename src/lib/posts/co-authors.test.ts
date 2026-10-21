import { describe, it, expect } from 'vitest'
import { coAuthorLimit, DEFAULT_CO_AUTHOR_LIMIT, MAX_CO_AUTHOR_LIMIT } from './co-authors'

describe('coAuthorLimit', () => {
  it("lets a squad's DEMO post credit as many people as the hackathon allows in a team", () => {
    expect(coAuthorLimit('DEMO', 6)).toBe(6)
    expect(coAuthorLimit('DEMO', 8)).toBe(8)
  })

  it('never goes past the hard cap of 10', () => {
    expect(MAX_CO_AUTHOR_LIMIT).toBe(10)
    expect(coAuthorLimit('DEMO', 11)).toBe(10)
    expect(coAuthorLimit('DEMO', 500)).toBe(10)
  })

  it('never drops a DEMO post below the general limit', () => {
    expect(coAuthorLimit('DEMO', 2)).toBe(DEFAULT_CO_AUTHOR_LIMIT)
  })

  it('keeps the general limit for a DEMO post without a hackathon, and for every other kind', () => {
    expect(coAuthorLimit('DEMO', null)).toBe(5)
    expect(coAuthorLimit('DEMO', 0)).toBe(5)
    for (const kind of ['SHIP', 'UPDATE', 'DEVLOG'] as const) expect(coAuthorLimit(kind, 10)).toBe(5)
  })
})
