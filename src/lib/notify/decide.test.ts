import { describe, it, expect } from 'vitest'
import { decideDelivery, DEFAULT_SETTINGS, type DeliveryFacts, type RecentSend } from './decide'

const NOON = new Date('2026-10-22T12:00:00Z')
const base: DeliveryFacts = {
  now: NOON,
  kind: 'COMMENT',
  channel: 'PUSH',
  timezone: 'UTC',
  settings: DEFAULT_SETTINGS,
  preference: undefined,
  marketingConsent: false,
  hasDestination: true,
  suppressed: false,
  duplicate: false,
  recent: [],
  createdAt: new Date('2026-10-22T11:59:00Z'),
}
const decide = (changes: Partial<DeliveryFacts>) => decideDelivery({ ...base, ...changes })
const sends = (kind: RecentSend['kind'], count: number, minutesAgo = 5): RecentSend[] => Array.from({ length: count }, () => ({ kind, sentAt: new Date(NOON.getTime() - minutesAgo * 60_000) }))

describe('decideDelivery', () => {
  it('sends a kind that is on by default, to someone with a destination, in the daytime', () => {
    expect(decide({})).toEqual({ action: 'SEND' })
  })

  it('does nothing for a channel a kind does not use, or a person who has nowhere to send to', () => {
    expect(decide({ channel: 'EMAIL' })).toEqual({ action: 'SKIP', reason: 'CHANNEL_OFF' })
    expect(decide({ hasDestination: false })).toEqual({ action: 'SKIP', reason: 'NO_DESTINATION' })
    expect(decide({ kind: 'DIGEST_DAILY', channel: 'PUSH' })).toEqual({ action: 'SKIP', reason: 'CHANNEL_OFF' })
  })

  it('lets the person’s own choice beat the default, either way', () => {
    expect(decide({ preference: false })).toEqual({ action: 'SKIP', reason: 'CHANNEL_OFF' })
    expect(decide({ kind: 'FOLLOW', preference: true })).toEqual({ action: 'SEND' })
    expect(decide({ kind: 'FOLLOW' })).toEqual({ action: 'SKIP', reason: 'CHANNEL_OFF' })
  })

  it('stops everything optional on a channel the person switched off as a whole', () => {
    expect(decide({ settings: { ...DEFAULT_SETTINGS, pushEnabled: false } })).toEqual({ action: 'SKIP', reason: 'CHANNEL_OFF' })
    expect(decide({ kind: 'NEW_MESSAGE', channel: 'EMAIL', settings: { ...DEFAULT_SETTINGS, emailEnabled: false } })).toEqual({ action: 'SKIP', reason: 'CHANNEL_OFF' })
  })

  it('never mails an address that bounced or complained, whatever the kind', () => {
    expect(decide({ kind: 'NEW_MESSAGE', channel: 'EMAIL', suppressed: true })).toEqual({ action: 'SKIP', reason: 'SUPPRESSED' })
    expect(decide({ kind: 'MODERATION', channel: 'EMAIL', suppressed: true })).toEqual({ action: 'SKIP', reason: 'SUPPRESSED' })
  })

  it('requires the marketing consent for a digest, and only for those', () => {
    expect(decide({ kind: 'DIGEST_DAILY', channel: 'EMAIL', createdAt: undefined })).toEqual({ action: 'SKIP', reason: 'NO_CONSENT' })
    expect(decide({ kind: 'DIGEST_DAILY', channel: 'EMAIL', createdAt: undefined, marketingConsent: true })).toEqual({ action: 'SEND' })
    expect(decide({ kind: 'NEW_MESSAGE', channel: 'EMAIL' })).toEqual({ action: 'SEND' })
  })

  it('sends an account notice whatever the switches, the preferences and the hour say', () => {
    const quiet = { ...base, kind: 'MODERATION' as const, channel: 'EMAIL' as const, now: new Date('2026-10-22T03:00:00Z'), createdAt: new Date('2026-10-22T02:59:00Z') }
    expect(decideDelivery({ ...quiet, settings: { ...DEFAULT_SETTINGS, emailEnabled: false }, preference: false })).toEqual({ action: 'SEND' })
  })

  it('skips what was already delivered', () => {
    expect(decide({ duplicate: true })).toEqual({ action: 'SKIP', reason: 'DUPLICATE' })
  })

  it('drops a notification that waited too long to still be news', () => {
    expect(decide({ createdAt: new Date('2026-10-21T10:00:00Z') })).toEqual({ action: 'SKIP', reason: 'STALE' })
  })

  it('holds a notification during quiet hours until they end, in the person’s own zone', () => {
    const decision = decide({ now: new Date('2026-10-22T20:00:00Z'), createdAt: new Date('2026-10-22T19:59:00Z'), timezone: 'Asia/Kolkata' })
    expect(decision).toEqual({ action: 'DEFER', until: new Date('2026-10-23T02:30:00Z'), reason: 'QUIET_HOURS' })
    expect(decide({ now: new Date('2026-10-22T20:00:00Z'), createdAt: new Date('2026-10-22T19:59:00Z'), timezone: 'America/New_York' })).toEqual({ action: 'SEND' })
  })

  it('holds back nothing when quiet hours are off', () => {
    expect(decide({ now: new Date('2026-10-22T03:00:00Z'), createdAt: new Date('2026-10-22T02:59:00Z'), settings: { ...DEFAULT_SETTINGS, enabled: false } })).toEqual({ action: 'SEND' })
  })

  describe('rate limits', () => {
    it('stops a kind at its own limit in its window, and starts again when the window has passed', () => {
      // COMMENT by push: 3 an hour.
      expect(decide({ recent: sends('COMMENT', 2) })).toEqual({ action: 'SEND' })
      expect(decide({ recent: sends('COMMENT', 3) })).toEqual({ action: 'SKIP', reason: 'RATE_LIMIT' })
      expect(decide({ recent: sends('COMMENT', 3, 61) })).toEqual({ action: 'SEND' })
    })

    it('counts the romance kinds together', () => {
      const romance = [...sends('ROMANCE_DROP', 1), ...sends('ROMANCE_SPARK', 1), ...sends('ROMANCE_MESSAGE', 1)]
      expect(decide({ kind: 'ROMANCE_REVEAL', recent: romance })).toEqual({ action: 'SKIP', reason: 'RATE_LIMIT' })
    })

    it('caps a channel across kinds, but leaves account notices out of the count and out of the cap', () => {
      const flood = [...sends('NEW_MESSAGE', 1), ...sends('SQUAD_INVITE', 1), ...sends('MATCH', 1)]
      expect(decide({ kind: 'PROPS', recent: flood })).toEqual({ action: 'SKIP', reason: 'RATE_LIMIT' })
      expect(decide({ kind: 'PROPS', recent: [...sends('MODERATION', 5), ...sends('NEW_MESSAGE', 1)] })).toEqual({ action: 'SEND' })
      expect(decide({ kind: 'MODERATION', recent: sends('NEW_MESSAGE', 9) })).toEqual({ action: 'SEND' })
    })

    it('does not count digests against the email cap, or hold a digest to it', () => {
      const six = sends('NEW_MESSAGE', 6, 300)
      expect(decide({ kind: 'DIGEST_DAILY', channel: 'EMAIL', createdAt: undefined, marketingConsent: true, recent: six })).toEqual({ action: 'SEND' })
      expect(decide({ kind: 'NEW_MESSAGE', channel: 'EMAIL', recent: [...sends('DIGEST_DAILY', 6, 300)] })).toEqual({ action: 'SEND' })
    })
  })
})
