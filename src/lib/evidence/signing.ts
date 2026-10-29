import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto'
import { canonicalize } from './canonical'

// Signing receipts (docs/PROOF.md). Ed25519 through node:crypto, over the canonical form of the receipt's envelope. The keys come from
// RECEIPT_SIGNING_KEYS, a comma-separated list of `kid=key`:
//
//   kid=<base64 PKCS#8 DER private key>     a key that can sign (and verify)
//   kid=pub:<base64url raw public key>      a retired key kept only so receipts it signed still verify
//
// The FIRST entry signs and must be a private key; every entry is published in the key set (GET /api/receipts/keys) by its public half. Rotating is: put
// a new key first, keep the old one after it (its public half is enough), deploy, and run receipts/sign-backlog only if receipts were left unsigned.
//
// Without the setting, development, tests and previews sign with FIXTURE_KEY: a fixed key whose private half is in this file, published under a kid
// that says it is not for production. A production deployment (requiresProductionConfig) never signs with it or with any key made up at start: it
// leaves receipts unsigned, warns at boot and reports "degraded" on /api/health, and the backlog job signs them once a key is set.

export interface SigningKey {
  kid: string
  publicKey: KeyObject
  /** Null for a retired key kept to verify. */
  privateKey: KeyObject | null
}

export interface KeySet {
  /** configured: from RECEIPT_SIGNING_KEYS; fixture: the development key; unsigned: production without a key. */
  mode: 'configured' | 'fixture' | 'unsigned'
  /** The key that signs, or null when nothing may sign. */
  active: SigningKey | null
  keys: SigningKey[]
}

export const FIXTURE_KID = 'dev-fixture-NOT-FOR-PRODUCTION'
/** The development and test key. Public on purpose: anything it signed proves nothing. */
const FIXTURE_PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIOKfaxErgSwQrhdKv3fc3sUUAiJi7oFdEX9Km+gPKpMK'

export const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export class KeySetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeySetError'
  }
}

function privateEntry(kid: string, base64: string): SigningKey {
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    // Never the value: only which entry.
    throw new KeySetError(`key ${kid} is not a PKCS#8 private key`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new KeySetError(`key ${kid} is not an Ed25519 key`)
  return { kid, privateKey, publicKey: createPublicKey(privateKey) }
}

function publicEntry(kid: string, x: string): SigningKey {
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
    return { kid, publicKey, privateKey: null }
  } catch {
    throw new KeySetError(`key ${kid} is not an Ed25519 public key`)
  }
}

/** Parses RECEIPT_SIGNING_KEYS. Throws KeySetError naming the entry (never its value). */
export function parseKeySetting(raw: string): SigningKey[] {
  const keys: SigningKey[] = []
  for (const part of raw.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    const kid = eq > 0 ? part.slice(0, eq) : ''
    if (!KID_PATTERN.test(kid)) throw new KeySetError('every entry must be kid=key, with a kid of letters, digits, dot, dash or underscore')
    if (keys.some((key) => key.kid === kid)) throw new KeySetError(`kid ${kid} appears twice`)
    const value = part.slice(eq + 1)
    keys.push(value.startsWith('pub:') ? publicEntry(kid, value.slice(4)) : privateEntry(kid, value))
  }
  if (keys.length === 0) throw new KeySetError('no keys')
  if (!keys[0].privateKey) throw new KeySetError('the first key signs, so it must be a private key')
  return keys
}

/** Pure on its inputs: the key set for a configuration. */
export function resolveKeySet(config: { RECEIPT_SIGNING_KEYS?: string; production: boolean }): KeySet {
  if (config.RECEIPT_SIGNING_KEYS) {
    const keys = parseKeySetting(config.RECEIPT_SIGNING_KEYS)
    return { mode: 'configured', active: keys[0], keys }
  }
  if (config.production) return { mode: 'unsigned', active: null, keys: [] }
  const fixture = privateEntry(FIXTURE_KID, FIXTURE_PRIVATE_KEY)
  return { mode: 'fixture', active: fixture, keys: [fixture] }
}

/** What a receipt's signature covers. `subject` names the person by their platform id, which never changes (the handle can). */
export interface ReceiptEnvelope {
  v: 1
  id: string
  subject: { platform: 'skill-dating'; userId: string }
  source: string
  sourceRef: string
  sourceUrl: string
  factsVersion: number
  facts: Record<string, unknown>
  payloadHash: string
  capturedAt: string
  kid: string
}

/** The signature (base64url) of the envelope's canonical form. */
export function signEnvelope(envelope: ReceiptEnvelope, key: SigningKey): string {
  if (!key.privateKey) throw new KeySetError(`key ${key.kid} cannot sign`)
  if (envelope.kid !== key.kid) throw new KeySetError('the envelope names another key')
  return edSign(null, Buffer.from(canonicalize(envelope), 'utf8'), key.privateKey).toString('base64url')
}

/** Whether `signature` is a valid signature of the envelope by the key its kid names in `keys`. */
export function verifyEnvelope(envelope: ReceiptEnvelope, signature: string, keys: readonly SigningKey[]): boolean {
  const key = keys.find((candidate) => candidate.kid === envelope.kid)
  if (!key) return false
  try {
    return edVerify(null, Buffer.from(canonicalize(envelope), 'utf8'), key.publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

export interface PublicJwk {
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
  kid: string
  use: 'sig'
  alg: 'EdDSA'
  /** The key that signs new receipts now. */
  active: boolean
}

/** The public halves, as a JWKS-style document. Never a private part. */
export function publicKeySet(set: KeySet): { keys: PublicJwk[]; mode: KeySet['mode'] } {
  return {
    mode: set.mode,
    keys: set.keys.map((key) => {
      const jwk = key.publicKey.export({ format: 'jwk' }) as { x: string }
      return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: key.kid, use: 'sig', alg: 'EdDSA', active: key === set.active }
    }),
  }
}
