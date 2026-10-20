import { describe, it, expect } from 'vitest'
import { reminderStageAt } from './reminders'

const HOUR = 60 * 60 * 1000
const deadline = new Date('2026-11-10T12:00:00Z')
const before = (ms: number) => new Date(deadline.getTime() - ms)

describe('reminderStageAt', () => {
  it('is nothing more than a week out, and nothing once the deadline has passed', () => {
    expect(reminderStageAt(deadline, before(7 * 24 * HOUR + 1))).toBeNull()
    expect(reminderStageAt(deadline, deadline)).toBeNull()
    expect(reminderStageAt(deadline, new Date(deadline.getTime() + HOUR))).toBeNull()
  })

  it('is the week reminder from seven days to two days', () => {
    expect(reminderStageAt(deadline, before(7 * 24 * HOUR))).toBe('T7D')
    expect(reminderStageAt(deadline, before(3 * 24 * HOUR))).toBe('T7D')
    expect(reminderStageAt(deadline, before(48 * HOUR + 1))).toBe('T7D')
  })

  it('is the solo-pool reminder from two days to one, then the last-day one', () => {
    expect(reminderStageAt(deadline, before(48 * HOUR))).toBe('T48H')
    expect(reminderStageAt(deadline, before(30 * HOUR))).toBe('T48H')
    expect(reminderStageAt(deadline, before(24 * HOUR))).toBe('T24H')
    expect(reminderStageAt(deadline, before(1))).toBe('T24H')
  })
})
