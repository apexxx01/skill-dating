import { describe, it, expect } from 'vitest'
import { ageRefusalAllows } from './handler'

describe('what a person refused for their age can still reach', () => {
  it('can see the account and ask for a correction', () => {
    expect(ageRefusalAllows('GET', '/api/users/me')).toBe(true)
    expect(ageRefusalAllows('GET', '/api/users/me/profile')).toBe(true)
    expect(ageRefusalAllows('POST', '/api/reports')).toBe(true)
    expect(ageRefusalAllows('GET', '/api/auth/session')).toBe(true)
    expect(ageRefusalAllows('GET', '/api/health')).toBe(true)
  })

  it('can reach nothing else, including the routes that would change their date or their profile', () => {
    for (const [method, path] of [
      ['PATCH', '/api/users'],
      ['PATCH', '/api/users/me/profile'],
      ['GET', '/api/dashboard'],
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['GET', '/api/reports'],
      ['POST', '/api/sparks'],
      ['GET', '/api/users/me/cosmetics'],
      ['DELETE', '/api/users/me'],
    ]) {
      expect(ageRefusalAllows(method, path), `${method} ${path}`).toBe(false)
    }
  })
})
