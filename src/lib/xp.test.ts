import { describe, it, expect } from 'vitest'
import { canAwardShipXp } from './xp'

describe('canAwardShipXp', () => {
  it('allows the award on first ship', () => {
    expect(canAwardShipXp({ status: 'BUILDING', shippedAt: null }, 'SHIPPED')).toBe(true)
  })

  it('blocks re-awarding on a repeated SHIPPED PATCH', () => {
    const alreadyShipped = { status: 'SHIPPED', shippedAt: new Date('2024-01-01') }
    expect(canAwardShipXp(alreadyShipped, 'SHIPPED')).toBe(false)
  })

  it('blocks farming via SHIPPED -> BUILDING -> SHIPPED cycling', () => {
    // Once shippedAt is set, it is never cleared by a later status change,
    // so re-declaring SHIPPED after reverting to BUILDING must not re-award.
    const previouslyShipped = { status: 'BUILDING', shippedAt: new Date('2024-01-01') }
    expect(canAwardShipXp(previouslyShipped, 'SHIPPED')).toBe(false)
  })

  it('does not award for any non-SHIPPED transition', () => {
    expect(canAwardShipXp({ status: 'IDEA', shippedAt: null }, 'BUILDING')).toBe(false)
    expect(canAwardShipXp({ status: 'IDEA', shippedAt: null }, undefined)).toBe(false)
  })
})
