import { env, requiresProductionConfig } from '@/lib/env'
import { resolveKeySet, type KeySet } from './signing'

// The process-wide receipt key set, from the environment (signing.ts says what each mode means). Read once and kept; setKeySet replaces it in tests.

const globalForKeys = globalThis as unknown as { __receiptKeys?: KeySet }

export function getKeySet(): KeySet {
  globalForKeys.__receiptKeys ??= resolveKeySet({ RECEIPT_SIGNING_KEYS: env.RECEIPT_SIGNING_KEYS, production: requiresProductionConfig(process.env) })
  return globalForKeys.__receiptKeys
}

/** Replaces the process-wide key set (tests). */
export function setKeySet(set: KeySet | undefined) {
  globalForKeys.__receiptKeys = set
}
