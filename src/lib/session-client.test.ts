import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachClerk, signIn, signOut } from './session-client'

describe('signIn', () => {
  const assign = vi.fn()

  beforeEach(() => {
    assign.mockReset()
    vi.stubGlobal('window', { location: { origin: 'https://app.test', assign } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands the visitor to the Clerk sign-in page instead of failing', async () => {
    const result = await signIn()
    expect(assign).toHaveBeenCalledWith('https://app.test/signin')
    expect(result).toEqual({ error: null, ok: true, status: 200, url: 'https://app.test/signin' })
  })

  it('ignores the provider and credentials the old call sites passed', async () => {
    await signIn('credentials', { email: 'a@b.c', password: 'secret-pw', redirect: false } as never)
    expect(assign).toHaveBeenCalledWith('https://app.test/signin')
  })

  it('keeps a callbackUrl that is a path on this site', async () => {
    await signIn('github', { callbackUrl: '/messages?x=1' })
    expect(assign).toHaveBeenCalledWith('https://app.test/signin?callbackUrl=%2Fmessages%3Fx%3D1')
  })

  it.each(['https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)', ''])(
    'drops a callbackUrl that could leave the site: %j',
    async (callbackUrl) => {
      await signIn(undefined, { callbackUrl })
      expect(assign).toHaveBeenCalledWith('https://app.test/signin')
    }
  )
})

describe('signOut', () => {
  beforeEach(() => {
    attachClerk(undefined)
  })
  afterEach(() => {
    attachClerk(undefined)
    vi.unstubAllGlobals()
  })

  it('ends the Clerk session and lets Clerk do the redirect, to "/" by default', async () => {
    const clerkSignOut = vi.fn().mockResolvedValue(undefined)
    attachClerk({ signOut: clerkSignOut })
    await signOut()
    expect(clerkSignOut).toHaveBeenCalledWith({ redirectUrl: '/' })
  })

  it('redirects to a callbackUrl that is a path on this site', async () => {
    const clerkSignOut = vi.fn().mockResolvedValue(undefined)
    attachClerk({ signOut: clerkSignOut })
    await signOut({ callbackUrl: '/signin?x=1' })
    expect(clerkSignOut).toHaveBeenCalledWith({ redirectUrl: '/signin?x=1' })
  })

  it.each(['https://evil.test/', '//evil.test', '/\\evil.test', ''])('falls back to "/" for a callbackUrl that could leave the site: %j', async (callbackUrl) => {
    const clerkSignOut = vi.fn().mockResolvedValue(undefined)
    attachClerk({ signOut: clerkSignOut })
    await signOut({ callbackUrl })
    expect(clerkSignOut).toHaveBeenCalledWith({ redirectUrl: '/' })
  })

  it('does not navigate by itself', async () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { origin: 'https://app.test', assign } })
    attachClerk({ signOut: vi.fn().mockResolvedValue(undefined) })
    await signOut({ callbackUrl: '/' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('falls back to window.Clerk when the provider has not attached one', async () => {
    const clerkSignOut = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { Clerk: { signOut: clerkSignOut } })
    await signOut()
    expect(clerkSignOut).toHaveBeenCalledWith({ redirectUrl: '/' })
  })

  it('prefers the instance the provider attached over window.Clerk', async () => {
    const attached = vi.fn().mockResolvedValue(undefined)
    const global = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { Clerk: { signOut: global } })
    attachClerk({ signOut: attached })
    await signOut()
    expect(attached).toHaveBeenCalledTimes(1)
    expect(global).not.toHaveBeenCalled()
  })

  it('fails loudly instead of pretending to sign out when Clerk is not loaded', async () => {
    vi.stubGlobal('window', {})
    await expect(signOut()).rejects.toThrow('Clerk has not loaded')
  })
})
