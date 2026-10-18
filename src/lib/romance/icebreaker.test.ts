import { describe, it, expect } from 'vitest'
import { ROMANCE_MODE_LABEL } from './config'
import { buildRomanceIcebreaker } from './icebreaker'

describe('buildRomanceIcebreaker', () => {
  it('says it is a match, in the mode\'s name, what the two share, and a question about work', () => {
    const text = buildRomanceIcebreaker(["You're both night-owl builders obsessed with climate tech", 'You both want to start a company', 'You both build with Rust'])
    expect(text).toBe(`It is a ${ROMANCE_MODE_LABEL} match. You're both night-owl builders obsessed with climate tech. You both want to start a company. A good first question: what are you most obsessed with building right now?`)
  })

  it('is still a greeting when the two share nothing the score could find', () => {
    expect(buildRomanceIcebreaker([])).toBe(`It is a ${ROMANCE_MODE_LABEL} match. A good first question: what are you most obsessed with building right now?`)
  })

  it('never guesses a pronoun and stays short', () => {
    const text = buildRomanceIcebreaker(['a', 'b', 'c'])
    expect(text).not.toMatch(/\b(she|he|her|his|him)\b/i)
    expect(text.length).toBeLessThanOrEqual(400)
  })
})
