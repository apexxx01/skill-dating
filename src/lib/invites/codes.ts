import { randomInt } from 'node:crypto'

// Invite codes: eight characters from an alphabet without the ones that look alike (no 0, O, 1, I or L), upper case. 31^8 is about 850 billion, so a code is not guessable
// by trying, and people can read one aloud or copy it from a screenshot. Pure apart from the randomness.

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

/** A code as typed: upper case, without spaces or hyphens ("k7m2-qx9d" is "K7M2QX9D"). Null if it cannot be a code. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null
}

/** An address in the form two accounts of one person would share: lower case, without a "+tag", and for Gmail without dots. */
export function canonicalEmail(email: string): string {
  const [rawLocal, rawDomain] = email.trim().toLowerCase().split('@')
  if (!rawLocal || !rawDomain) return email.trim().toLowerCase()
  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain
  let local = rawLocal.split('+')[0]
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}
