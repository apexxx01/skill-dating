import { describe, it, expect } from 'vitest'
import { NotificationType } from '@prisma/client'
import { NOTIFICATION_KINDS } from '@/lib/notification-kinds'
import { DELIVERY_KINDS, KIND_OF_TYPE, POLICY, deliveryKindOf, groupOf, isImmediateKind, isImmediateNotification, kindsInGroup, switchableKinds } from './policy'
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

  it('makes the digests account mail on their own cadence, on by default and email-only', () => {
    for (const kind of ['DIGEST_DAILY', 'DIGEST_WEEKLY'] as const) {
      expect(POLICY[kind].class).toBe('ACTIVITY')
      expect(POLICY[kind].ownCadence).toBe(true)
      expect(POLICY[kind].email.default).toBe(true)
      expect(POLICY[kind].push.unavailable).toBe(true)
    }
  })

  it('has no promotional kind: anything that needs the marketing consent is a product decision made on purpose', () => {
    expect(DELIVERY_KINDS.filter((kind) => POLICY[kind].class === 'PROMOTIONAL')).toEqual([])
  })
})

describe('immediate dispatch', () => {
  it('is for exactly the time-critical kinds, and a new one is a decision made on purpose', () => {
    expect(DELIVERY_KINDS.filter((kind) => POLICY[kind].immediate).sort()).toEqual(['MATCH', 'MATCH_CREATED', 'MODERATION', 'ROMANCE_MATCH', 'SPARK', 'SQUAD_INVITE', 'SQUAD_REMINDER'])
  })

  it('applies to a kind whole, or to a notification whose metadata matches', () => {
    for (const kind of ['SPARK', 'MATCH_CREATED', 'MATCH', 'SQUAD_INVITE', 'MODERATION'] as const) expect(isImmediateKind(kind, undefined), kind).toBe(true)
    // The squad reminder: only the one a day before registration closes.
    expect(isImmediateKind('SQUAD_REMINDER', { stage: 'T24H' })).toBe(true)
    for (const stage of ['T7D', 'T48H', undefined]) expect(isImmediateKind('SQUAD_REMINDER', { stage }), String(stage)).toBe(false)
    expect(isImmediateKind('SQUAD_REMINDER', null)).toBe(false)
    expect(isImmediateKind('SQUAD_REMINDER', ['T24H'])).toBe(false)
  })

  it('leaves the rest batched: comments, Props, follows, messages, the digests, and the other squad kinds', () => {
    for (const kind of ['COMMENT', 'PROPS', 'FOLLOW', 'NEW_MESSAGE', 'MENTION', 'SQUAD_PROPOSAL', 'SQUAD_UPDATE', 'HACKATHON_REMINDER', 'DIGEST_DAILY', 'DIGEST_WEEKLY', 'LEVEL_UP'] as const) expect(isImmediateKind(kind, { stage: 'T24H' }), kind).toBe(false)
  })

  it('reads a stored notification the way the pipeline does', () => {
    expect(isImmediateNotification({ type: 'MATCH', metadata: { kind: 'MATCH_CREATED', matchId: 'm' } })).toBe(true)
    expect(isImmediateNotification({ type: 'SYSTEM', metadata: { kind: 'MODERATION', actionId: 'a' } })).toBe(true)
    expect(isImmediateNotification({ type: 'SYSTEM', metadata: { kind: 'SQUAD_REMINDER', stage: 'T24H' } })).toBe(true)
    expect(isImmediateNotification({ type: 'SYSTEM', metadata: { kind: 'SQUAD_REMINDER', stage: 'T7D' } })).toBe(false)
    expect(isImmediateNotification({ type: 'COMMENT', metadata: null })).toBe(false)
    // A romance match is told at once too, in its neutral form (the pipeline resolves it to ROMANCE_MATCH); the other romance kinds wait for the sweep.
    expect(isImmediateNotification({ type: 'MATCH', metadata: { kind: 'MATCH_CREATED', connectionType: 'DATING' } })).toBe(true)
    expect(POLICY.ROMANCE_MATCH.exposure).toBe('NEUTRAL')
    for (const kind of ['ROMANCE_MESSAGE', 'ROMANCE_SPARK', 'ROMANCE_DROP', 'ROMANCE_REVEAL', 'ROMANCE_DUO'] as const) expect(POLICY[kind].immediate, kind).toBeUndefined()
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
