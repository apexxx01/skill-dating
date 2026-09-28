import { describe, it, expect, vi } from 'vitest'
import { canAwardShipXp, awardXp, XP_AWARDS } from './xp'

function mockPrisma() {
  return {
    xPEvent: { create: vi.fn().mockResolvedValue({}) },
    user: { update: vi.fn().mockResolvedValue({}) },
  } as any
}

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

describe('awardXp', () => {
  it('creates an XPEvent for the right type/amount and increments User.xp by the same amount', async () => {
    const prisma = mockPrisma()
    await awardXp(prisma, 'user1', 'PROJECT_SHIP', 'Shipped project "Foo"')

    expect(prisma.xPEvent.create).toHaveBeenCalledWith({
      data: { userId: 'user1', type: 'PROJECT_SHIP', amount: XP_AWARDS.PROJECT_SHIP, description: 'Shipped project "Foo"' }
    })
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { xp: { increment: XP_AWARDS.PROJECT_SHIP } }
    })
  })

  it('uses the correct amount per award type, not a shared constant', async () => {
    const prisma = mockPrisma()
    await awardXp(prisma, 'user1', 'TEAM_FORMED', 'Formed team')
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { xp: { increment: XP_AWARDS.TEAM_FORMED } }
    })
    expect(XP_AWARDS.TEAM_FORMED).not.toBe(XP_AWARDS.PROJECT_SHIP)
  })
})
