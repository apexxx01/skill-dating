import { describe, it, expect } from 'vitest'
import disposable from '@/config/disposable-email-domains.json'
import { emailDomain, isDisposableEmail } from './signup'

describe('isDisposableEmail', () => {
  it('refuses the domains in the config file, and their subdomains', () => {
    expect(disposable.domains.length).toBeGreaterThan(20)
    expect(isDisposableEmail('someone@mailinator.com')).toBe(true)
    expect(isDisposableEmail('Someone@MAILINATOR.COM')).toBe(true)
    expect(isDisposableEmail('x@inbox.mailinator.com')).toBe(true)
    expect(isDisposableEmail('x@yopmail.fr')).toBe(true)
  })

  it('accepts ordinary domains, including ones that only end like a listed one', () => {
    expect(isDisposableEmail('ada@gmail.com')).toBe(false)
    expect(isDisposableEmail('ada@notmailinator.com')).toBe(false)
    expect(isDisposableEmail('ada@company.co.in')).toBe(false)
  })

  it('is false for nothing or nonsense', () => {
    expect(isDisposableEmail(null)).toBe(false)
    expect(isDisposableEmail('no-at-sign')).toBe(false)
    expect(emailDomain('a@')).toBeNull()
  })

  it('keeps the list sorted and lower-case, so it stays easy to update', () => {
    expect(disposable.domains).toEqual([...disposable.domains].map((d) => d.toLowerCase()).sort())
  })
})
