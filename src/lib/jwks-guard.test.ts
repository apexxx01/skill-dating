import { describe, it, expect, vi } from 'vitest'
import { createKidGuard, tokenKid } from './jwks-guard'

function harness(kids: string[] | (() => Promise<string[]>)) {
  let t = 1_000_000
  const fetchKids = vi.fn(typeof kids === 'function' ? kids : async () => kids)
  const guard = createKidGuard(fetchKids, { refreshCooldownMs: 60_000, ttlMs: 300_000, now: () => t })
  return { guard, fetchKids, advance: (ms: number) => { t += ms } }
}

describe('createKidGuard', () => {
  it('lets a real kid through after one fetch and does not fetch again while fresh', async () => {
    const h = harness(['ins_real'])
    expect(await h.guard.allows('ins_real')).toBe(true)
    expect(await h.guard.allows('ins_real')).toBe(true)
    expect(await h.guard.allows('ins_real')).toBe(true)
    expect(h.fetchKids).toHaveBeenCalledTimes(1)
  })

  it('turns a flood of junk kids into at most one refresh per cooldown', async () => {
    const h = harness(['ins_real'])
    await h.guard.allows('ins_real')
    for (let i = 0; i < 200; i++) expect(await h.guard.allows(`ins_junk_${i}`)).toBe(false)
    // The first fetch loaded the real kid; the cooldown it started blocks every junk kid after it.
    expect(h.fetchKids).toHaveBeenCalledTimes(1)
    h.advance(61_000)
    for (let i = 0; i < 200; i++) expect(await h.guard.allows(`ins_more_${i}`)).toBe(false)
    expect(h.fetchKids).toHaveBeenCalledTimes(2)
  })

  it('cannot be starved by junk: a real kid arriving after junk on a cold start is still accepted', async () => {
    const h = harness(['ins_real'])
    expect(await h.guard.allows('ins_junk')).toBe(false)
    expect(await h.guard.allows('ins_real')).toBe(true)
    expect(h.fetchKids).toHaveBeenCalledTimes(1)
  })

  it('accepts a newly rotated kid once the cooldown allows a refresh', async () => {
    let kids = ['ins_old']
    const h = harness(async () => kids)
    expect(await h.guard.allows('ins_old')).toBe(true)
    kids = ['ins_old', 'ins_new']
    expect(await h.guard.allows('ins_new')).toBe(false)
    h.advance(61_000)
    expect(await h.guard.allows('ins_new')).toBe(true)
  })

  it('shares one in-flight fetch between concurrent callers', async () => {
    let release: (k: string[]) => void = () => {}
    const h = harness(() => new Promise<string[]>((r) => { release = r }))
    const calls = Promise.all([h.guard.allows('ins_real'), h.guard.allows('ins_real'), h.guard.allows('ins_junk')])
    release(['ins_real'])
    expect(await calls).toEqual([true, true, false])
    expect(h.fetchKids).toHaveBeenCalledTimes(1)
  })

  it('keeps trusting known kids while Clerk is unreachable, and refuses unknown ones', async () => {
    let fail = false
    const h = harness(async () => {
      if (fail) throw new Error('down')
      return ['ins_real']
    })
    expect(await h.guard.allows('ins_real')).toBe(true)
    fail = true
    h.advance(400_000) // the set is stale, a refresh is due and fails
    expect(await h.guard.allows('ins_real')).toBe(true)
    expect(await h.guard.allows('ins_other')).toBe(false)
  })

  it('refuses an empty kid without fetching', async () => {
    const h = harness(['ins_real'])
    expect(await h.guard.allows('')).toBe(false)
    expect(h.fetchKids).not.toHaveBeenCalled()
  })
})

describe('tokenKid', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

  it('reads the kid from the header', () => {
    expect(tokenKid(`${b64({ alg: 'RS256', kid: 'ins_1' })}.e30.sig`)).toBe('ins_1')
  })

  it('returns null for anything that is not a JWT header with a kid', () => {
    expect(tokenKid('')).toBeNull()
    expect(tokenKid('not-a-jwt')).toBeNull()
    expect(tokenKid(`${b64({ alg: 'RS256' })}.e30.sig`)).toBeNull()
    expect(tokenKid(`${b64({ kid: 5 })}.e30.sig`)).toBeNull()
    expect(tokenKid(`${b64({ kid: 'x'.repeat(500) })}.e30.sig`)).toBeNull()
  })
})
