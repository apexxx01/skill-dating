import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { checkActionShape, DESTRUCTIVE_ACTIONS, MODERATION_ACTIONS } from './actions'

describe('checkActionShape', () => {
  it('hides and removes content only, never a user', () => {
    expect(checkActionShape({ action: 'HIDE_CONTENT', targetType: 'SHIP_POST' })).toBeNull()
    expect(checkActionShape({ action: 'REMOVE_CONTENT', targetType: 'MESSAGE' })).toBeNull()
    expect(checkActionShape({ action: 'HIDE_CONTENT', targetType: 'USER' })).toMatchObject({ code: 'MODERATION_ACTION_INVALID' })
  })

  it('approves media only', () => {
    expect(checkActionShape({ action: 'APPROVE_MEDIA', targetType: 'MEDIA' })).toBeNull()
    expect(checkActionShape({ action: 'APPROVE_MEDIA', targetType: 'COMMENT' })).toMatchObject({ code: 'MODERATION_ACTION_INVALID' })
  })

  it('needs a feature to restrict and a duration to suspend', () => {
    expect(checkActionShape({ action: 'RESTRICT_FEATURE', targetType: 'USER' })).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(checkActionShape({ action: 'RESTRICT_FEATURE', targetType: 'USER', feature: 'messaging' })).toBeNull()
    expect(checkActionShape({ action: 'SUSPEND', targetType: 'USER' })).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(checkActionShape({ action: 'SUSPEND', targetType: 'USER', durationDays: 7 })).toBeNull()
    expect(checkActionShape({ action: 'BAN', targetType: 'USER' })).toBeNull()
    expect(checkActionShape({ action: 'WARN', targetType: 'COMMENT' })).toBeNull()
  })

  it('names ban and content removal as the destructive actions', () => {
    expect([...DESTRUCTIVE_ACTIONS].sort()).toEqual(['BAN', 'REMOVE_CONTENT'])
    expect(MODERATION_ACTIONS).toHaveLength(7)
  })
})
