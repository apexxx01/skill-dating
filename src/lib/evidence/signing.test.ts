import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { canonicalHash } from './canonical'
import { base62Of, isReceiptId, newReceiptId, RECEIPT_ID_LENGTH } from './receipt-id'
import { FIXTURE_KID, KeySetError, parseKeySetting, publicKeySet, resolveKeySet, signEnvelope, verifyEnvelope, type ReceiptEnvelope } from './signing'

function freshKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), x: (publicKey.export({ format: 'jwk' }) as { x: string }).x }
}

function envelope(kid: string, facts: Record<string, unknown> = { commits: { authored: 3 }, repo: { id: '1' } }): ReceiptEnvelope {
  return {
    v: 1,
    id: newReceiptId(),
    subject: { platform: 'skill-dating', userId: 'u1' },
    source: 'github',
    sourceRef: 'repo:1@commit:abc',
    sourceUrl: 'https://github.com/a/b',
    factsVersion: 1,
    facts,
    payloadHash: canonicalHash(facts),
    capturedAt: '2026-10-29T00:00:00.000Z',
    kid,
  }
}

describe('receipt ids', () => {
  it('are 22 base62 characters', () => {
    for (let i = 0; i < 200; i++) expect(newReceiptId()).toMatch(/^[0-9A-Za-z]{22}$/)
    expect(RECEIPT_ID_LENGTH).toBe(22)
  })

  it('encode the 128 bits exactly, padded at both ends of the range', () => {
    expect(base62Of(new Uint8Array(16))).toBe('0'.repeat(22))
    expect(base62Of(new Uint8Array(16).fill(255))).toBe('7n42DGM5Tflk9n8mt7Fhc7')
    const one = new Uint8Array(16)
    one[15] = 1
    expect(base62Of(one)).toBe('0'.repeat(21) + '1')
    expect(() => base62Of(new Uint8Array(15))).toThrow()
  })

  it('are not ordered: two ids made one after the other share no prefix by construction', () => {
    const ids = Array.from({ length: 500 }, () => newReceiptId())
    expect(new Set(ids).size).toBe(500)
    const sorted = [...ids].sort()
    expect(sorted).not.toEqual(ids)
    expect(isReceiptId(ids[0])).toBe(true)
    expect(isReceiptId('ckabc123')).toBe(false)
    expect(isReceiptId(ids[0] + 'x')).toBe(false)
  })
})

describe('the key set', () => {
  it('signs with the fixture key outside production and with nothing in production', () => {
    const dev = resolveKeySet({ production: false })
    expect(dev.mode).toBe('fixture')
    expect(dev.active?.kid).toBe(FIXTURE_KID)
    const prod = resolveKeySet({ production: true })
    expect(prod).toMatchObject({ mode: 'unsigned', active: null, keys: [] })
  })

  it('reads configured keys, the first one signing, retired public keys kept for verification', () => {
    const current = freshKey()
    const retired = freshKey()
    const set = resolveKeySet({ RECEIPT_SIGNING_KEYS: `2026-11=${current.pkcs8},2026-01=pub:${retired.x}`, production: true })
    expect(set.mode).toBe('configured')
    expect(set.active?.kid).toBe('2026-11')
    expect(set.keys.map((key) => [key.kid, key.privateKey !== null])).toEqual([['2026-11', true], ['2026-01', false]])
  })

  it('refuses a bad setting without echoing it', () => {
    const secret = freshKey().pkcs8
    const cases = [`=${secret}`, `bad kid=${secret}`, `a=notakey`, `a=pub:${freshKey().x}`, `a=${secret},a=${secret}`, ' , ']
    for (const raw of cases) {
      let message = ''
      try {
        parseKeySetting(raw)
      } catch (error) {
        expect(error).toBeInstanceOf(KeySetError)
        message = (error as Error).message
      }
      expect(message, raw).not.toBe('')
      expect(message).not.toContain(secret)
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    expect(() => parseKeySetting(`a=${rsa}`)).toThrow(/not an Ed25519 key/)
  })

  it('publishes only public halves', () => {
    const current = freshKey()
    const set = resolveKeySet({ RECEIPT_SIGNING_KEYS: `k1=${current.pkcs8}`, production: true })
    const published = publicKeySet(set)
    expect(published.keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: current.x, kid: 'k1', use: 'sig', alg: 'EdDSA', active: true }])
    expect(JSON.stringify(published)).not.toContain(current.pkcs8)
    expect(JSON.stringify(published)).not.toMatch(/"d"/)
  })
})

describe('signing and verifying', () => {
  const current = freshKey()
  const set = resolveKeySet({ RECEIPT_SIGNING_KEYS: `k1=${current.pkcs8}`, production: true })

  it('round-trips', () => {
    const env = envelope('k1')
    const signature = signEnvelope(env, set.active!)
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(verifyEnvelope(env, signature, set.keys)).toBe(true)
    // The member order of the JSON a verifier holds does not matter.
    const { kid, facts, ...rest } = env
    const reordered = JSON.parse(JSON.stringify({ kid, facts, ...rest })) as ReceiptEnvelope
    expect(verifyEnvelope(reordered, signature, set.keys)).toBe(true)
  })

  it('fails for tampered facts, a changed subject, another key or a damaged signature', () => {
    const env = envelope('k1')
    const signature = signEnvelope(env, set.active!)
    expect(verifyEnvelope({ ...env, facts: { ...env.facts, commits: { authored: 300 } } }, signature, set.keys)).toBe(false)
    expect(verifyEnvelope({ ...env, subject: { platform: 'skill-dating', userId: 'u2' } }, signature, set.keys)).toBe(false)
    expect(verifyEnvelope({ ...env, capturedAt: '2020-01-01T00:00:00.000Z' }, signature, set.keys)).toBe(false)
    expect(verifyEnvelope(env, signature.slice(0, -2) + (signature.endsWith('A') ? 'BA' : 'AA'), set.keys)).toBe(false)
    expect(verifyEnvelope(env, 'not-base64!!', set.keys)).toBe(false)
    const other = resolveKeySet({ RECEIPT_SIGNING_KEYS: `k1=${freshKey().pkcs8}`, production: true })
    expect(verifyEnvelope(env, signature, other.keys)).toBe(false)
  })

  it('keeps verifying what an old key signed after rotation, and signs new receipts with the new key', () => {
    const old = freshKey()
    const before = resolveKeySet({ RECEIPT_SIGNING_KEYS: `old=${old.pkcs8}`, production: true })
    const signedBefore = envelope('old')
    const oldSignature = signEnvelope(signedBefore, before.active!)

    const fresh = freshKey()
    const after = resolveKeySet({ RECEIPT_SIGNING_KEYS: `new=${fresh.pkcs8},old=pub:${old.x}`, production: true })
    expect(after.active?.kid).toBe('new')
    expect(verifyEnvelope(signedBefore, oldSignature, after.keys)).toBe(true)
    const signedAfter = envelope('new')
    expect(verifyEnvelope(signedAfter, signEnvelope(signedAfter, after.active!), after.keys)).toBe(true)
    // A retired key cannot sign.
    expect(() => signEnvelope(envelope('old'), after.keys[1])).toThrow(KeySetError)
    // An envelope must name the key that signs it.
    expect(() => signEnvelope(envelope('old'), after.active!)).toThrow(KeySetError)
    // Once a key is dropped from the set entirely, what it signed no longer verifies against the set.
    const dropped = resolveKeySet({ RECEIPT_SIGNING_KEYS: `new=${fresh.pkcs8}`, production: true })
    expect(verifyEnvelope(signedBefore, oldSignature, dropped.keys)).toBe(false)
  })
})
