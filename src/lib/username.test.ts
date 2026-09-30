import { describe, it, expect } from 'vitest'
import { isCurrentUsernameFor, MAX_USERNAME_LENGTH, resolveUsername, sanitizeUsername, usernameCandidates } from './username'

const taken = (names: Record<string, string>) => async (name: string) => names[name] ?? null

describe('sanitizeUsername', () => {
  it('lowercases and strips characters the app does not allow', () => {
    expect(sanitizeUsername('Aanya.Builds!')).toBe('aanyabuilds')
  })
  it('falls back to a fixed name when nothing usable is left', () => {
    expect(sanitizeUsername('!!!')).toBe('user')
    expect(sanitizeUsername(null)).toBe('user')
  })
  it('caps the length', () => {
    expect(sanitizeUsername('a'.repeat(80))).toHaveLength(MAX_USERNAME_LENGTH)
  })
})

describe('resolveUsername', () => {
  const clerkId = 'user_2abCDefGhIjKlMnOp'

  it('uses the Clerk username when it is free', async () => {
    expect(await resolveUsername('Alice', clerkId, taken({}))).toBe('alice')
  })

  it('adds a suffix from the Clerk id when another user holds the name', async () => {
    expect(await resolveUsername('alice', clerkId, taken({ alice: 'other' }))).toBe('alice_2abcde')
  })

  it('is deterministic: the same inputs give the same name every time', async () => {
    const a = await resolveUsername('alice', clerkId, taken({ alice: 'other' }))
    const b = await resolveUsername('alice', clerkId, taken({ alice: 'other' }))
    expect(a).toBe(b)
  })

  it('walks to a longer suffix when the first suffixed name is also taken', async () => {
    const name = await resolveUsername('alice', clerkId, taken({ alice: 'x', alice_2abcde: 'y' }))
    expect(name).toBe('alice_2abcdefg')
  })

  it('treats a name the account already owns as free', async () => {
    expect(await resolveUsername('alice', clerkId, taken({ alice: 'me' }), 'me')).toBe('alice')
  })

  it('never exceeds the maximum length, even with a long base', async () => {
    const long = 'x'.repeat(60)
    const all = usernameCandidates(long, clerkId)
    expect(all.every((c) => c.length <= MAX_USERNAME_LENGTH)).toBe(true)
    const name = await resolveUsername(long, clerkId, taken({ [sanitizeUsername(long)]: 'other' }))
    expect(name.length).toBeLessThanOrEqual(MAX_USERNAME_LENGTH)
    expect(name).not.toBe(sanitizeUsername(long))
  })

  it('gives two different Clerk accounts that want the same name different results', async () => {
    const a = await resolveUsername('sam', 'user_aaaaaaaaaaaa', taken({ sam: 'other' }))
    const b = await resolveUsername('sam', 'user_bbbbbbbbbbbb', taken({ sam: 'other' }))
    expect(a).not.toBe(b)
  })
})

describe('isCurrentUsernameFor', () => {
  const clerkId = 'user_2abCDefGhIjKlMnOp'

  it('accepts the plain name and its suffixed forms', () => {
    expect(isCurrentUsernameFor('alice', 'Alice', clerkId)).toBe(true)
    expect(isCurrentUsernameFor('alice_2abcde', 'alice', clerkId)).toBe(true)
    expect(isCurrentUsernameFor('alice_2abcdefg', 'alice', clerkId)).toBe(true)
  })

  it('keeps a legacy name that only differs by characters Clerk does not allow', () => {
    expect(isCurrentUsernameFor('fatima.pm', 'fatimapm', clerkId)).toBe(true)
    expect(isCurrentUsernameFor('Sam.Builds.Things', 'sambuildsthings', clerkId)).toBe(true)
    expect(isCurrentUsernameFor('fatima.pm', 'someoneelse', clerkId)).toBe(false)
  })

  it('rejects a name derived from a different Clerk name or a different Clerk id', () => {
    expect(isCurrentUsernameFor('alice', 'bob', clerkId)).toBe(false)
    expect(isCurrentUsernameFor('alice_zzzzzz', 'alice', clerkId)).toBe(false)
  })
})
