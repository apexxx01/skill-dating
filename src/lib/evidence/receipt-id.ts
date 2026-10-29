import { randomBytes } from 'node:crypto'

// A receipt's public id: 128 random bits written in base62, always 22 characters (62^22 is above 2^128). Not a cuid: a cuid carries a timestamp and a
// counter, so ids would be ordered and the next one guessable; a receipt address must reveal nothing and be impossible to enumerate.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const RECEIPT_ID_LENGTH = 22
export const RECEIPT_ID_PATTERN = /^[0-9A-Za-z]{22}$/

/** Pure: 16 bytes as a 22-character base62 string, most significant digit first, padded with zeros. */
export function base62Of(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('a receipt id is 16 bytes')
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out
    n /= 62n
  }
  return out.padStart(RECEIPT_ID_LENGTH, '0')
}

export function newReceiptId(random: (size: number) => Uint8Array = randomBytes): string {
  return base62Of(random(16))
}

export const isReceiptId = (value: string): boolean => RECEIPT_ID_PATTERN.test(value)
