import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signIn } from './session-client'

describe('signIn', () => {
  const assign = vi.fn()

  beforeEach(() => {
    assign.mockReset()
    vi.stubGlobal('window', { location: { origin: 'https://app.test', assign } })
  })
  afterEach(() => vi.unstubAllGlobals())

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
