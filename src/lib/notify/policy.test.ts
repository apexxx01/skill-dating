import { describe, it, expect } from 'vitest'
import { NotificationType } from '@prisma/client'
import { NOTIFICATION_KINDS } from '@/lib/notification-kinds'
import { DELIVERY_KINDS, KIND_OF_TYPE, POLICY, deliveryKindOf, groupOf, kindsInGroup, switchableKinds } from './policy'
import { LOCALES, stringTables, t, tn } from './strings'

describe('the channel policy', () => {
  it('covers every kind a person can switch in-app', () => {
    for (const kind of NOTIFICATION_KINDS) expect(POLICY[kind], kind).toBeDefined()
  })

  it('covers every stored notification type, so a notification that names no kind still has a policy', () => {
    for (const type of Object.values(NotificationType)) {
      expect(KIND_OF_TYPE[type], type).toBeDefined()
      expect(POLICY[KIND_OF_TYPE[type]], type).toBeDefined()
    }
  })

  it('has a policy for exactly the kinds it lists', () => {
    expect(Object.keys(POLICY).sort()).toEqual([...DELIVERY_KINDS].sort())
  })

  it('shows nothing but a neutral line for every romance kind, and gives them one shared limit', () => {
    const romance = DELIVERY_KINDS.filter((kind) => kind.startsWith('ROMANCE_'))
    expect(romance.length).toBeGreaterThanOrEqual(7)
    for (const kind of romance) {
      expect(POLICY[kind].exposure, kind).toBe('NEUTRAL')
      expect(groupOf(kind), kind).toBe('ROMANCE')
      // Never on by default by email: that is opt-in.
      expect(POLICY[kind].email.default, kind).toBe(false)
    }
    expect(kindsInGroup('ROMANCE_DROP')).toEqual(expect.arrayContaining(['ROMANCE_SPARK', 'ROMANCE_MESSAGE', 'ROMANCE_MATCH']))
  })

  it('keeps account notices out of the switches and shows only that there is one', () => {
    expect(switchableKinds()).not.toContain('MODERATION')
    expect(switchableKinds()).not.toContain('DATA_EXPORT')
    expect(POLICY.MODERATION.exposure).toBe('ACCOUNT')
    expect(POLICY.MODERATION.class).toBe('SECURITY')
  })

  it('makes the digests promotional and email-only', () => {
    for (const kind of ['DIGEST_DAILY', 'DIGEST_WEEKLY'] as const) {
      expect(POLICY[kind].class).toBe('PROMOTIONAL')
      expect(POLICY[kind].push.unavailable).toBe(true)
    }
  })

  it('never makes an activity kind promotional by accident: only the digests are', () => {
    expect(DELIVERY_KINDS.filter((kind) => POLICY[kind].class === 'PROMOTIONAL').sort()).toEqual(['DIGEST_DAILY', 'DIGEST_WEEKLY'])
  })
})

describe('deliveryKindOf', () => {
  it('uses the kind a notification names', () => {
    expect(deliveryKindOf({ type: 'SYSTEM', metadata: { kind: 'SQUAD_UPDATE' } })).toBe('SQUAD_UPDATE')
    expect(deliveryKindOf({ type: 'SYSTEM', metadata: { kind: 'MODERATION', actionId: 'a' } })).toBe('MODERATION')
  })

  it('falls back to the type, for a notification that names no kind or one the policy does not know', () => {
    expect(deliveryKindOf({ type: 'NEW_MESSAGE', metadata: { conversationId: 'c' } })).toBe('NEW_MESSAGE')
    expect(deliveryKindOf({ type: 'TEAM_INVITATION', metadata: null })).toBe('TEAM_INVITATION')
    expect(deliveryKindOf({ type: 'SYSTEM', metadata: { kind: 'SOMETHING_NEW' } })).toBe('SYSTEM')
    expect(deliveryKindOf({ type: 'SYSTEM', metadata: [1, 2] })).toBe('SYSTEM')
  })

  it('turns a match or a message that belongs to the romance mode into its neutral twin', () => {
    expect(deliveryKindOf({ type: 'MATCH', metadata: { kind: 'MATCH_CREATED', connectionType: 'DATING' } })).toBe('ROMANCE_MATCH')
    expect(deliveryKindOf({ type: 'MATCH', metadata: { kind: 'MATCH_CREATED', connectionType: 'COFOUNDER' } })).toBe('MATCH_CREATED')
    expect(deliveryKindOf({ type: 'NEW_MESSAGE', metadata: { connectionType: 'DATING' } })).toBe('ROMANCE_MESSAGE')
  })
})

describe('the strings', () => {
  it('has the same keys in every language', () => {
    const [first, ...others] = LOCALES
    for (const locale of others) expect(Object.keys(stringTables[locale]).sort()).toEqual(Object.keys(stringTables[first]).sort())
  })

  it('fills placeholders and leaves unknown ones in place', () => {
    expect(t('en', 'digest.weekly.season.standing', { rank: 3, season: 'Season 2', score: 120 })).toBe('You are #3 in Season 2 with 120 XP')
    expect(t('en', 'email.greeting', {})).toBe('Hi {name},')
  })

  it('picks the plural form', () => {
    expect(tn('en', 'digest.daily.sparks', 1)).toBe('1 person sparked you')
    expect(tn('en', 'digest.daily.sparks', 4)).toBe('4 people sparked you')
    expect(tn('en', 'digest.daily.sparks', 0)).toBe('0 people sparked you')
  })

  it('never names the romance mode in what is sent out', () => {
    for (const [key, value] of Object.entries(stringTables.en)) expect(value.toLowerCase(), key).not.toMatch(/romance|dating|date night|crush/)
  })
})
