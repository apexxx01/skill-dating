import { describe, it, expect } from 'vitest'
import { withUtcSession } from './database-url'

const optionsOf = (url: string) => new URL(url).searchParams.get('options')

describe('withUtcSession', () => {
  it('asks for a UTC session and keeps the rest of the URL', () => {
    const url = withUtcSession('postgresql://user:pass@db.example.com:5432/app?schema=public&sslmode=require')
    expect(optionsOf(url)).toBe('-c timezone=UTC')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('schema')).toBe('public')
    expect(parsed.searchParams.get('sslmode')).toBe('require')
    expect(parsed.hostname).toBe('db.example.com')
    expect(parsed.pathname).toBe('/app')
    expect(parsed.username).toBe('user')
    expect(parsed.password).toBe('pass')
  })

  it('writes the space as %20, not +', () => {
    expect(withUtcSession('postgresql://u:p@h/db')).toContain('options=-c%20timezone%3DUTC')
  })

  it('works for a URL with no query at all', () => {
    expect(optionsOf(withUtcSession('postgres://u:p@h:5432/db'))).toBe('-c timezone=UTC')
  })

  it('replaces another time zone, in either spelling, and keeps other options', () => {
    expect(optionsOf(withUtcSession('postgresql://u:p@h/db?options=-c%20timezone%3DAsia%2FKolkata'))).toBe('-c timezone=UTC')
    expect(optionsOf(withUtcSession('postgresql://u:p@h/db?options=--timezone%3DEurope%2FParis'))).toBe('-c timezone=UTC')
    expect(optionsOf(withUtcSession('postgresql://u:p@h/db?options=-c%20statement_timeout%3D5000%20-c%20TimeZone%3DAmerica%2FNew_York'))).toBe(
      '-c statement_timeout=5000 -c timezone=UTC'
    )
  })

  it('is stable when applied twice', () => {
    const once = withUtcSession('postgresql://u:p@h/db?schema=public')
    expect(withUtcSession(once)).toBe(once)
  })

  it('keeps a password that needs escaping intact', () => {
    const url = withUtcSession('postgresql://u:p%40ss%2Fword@h/db')
    expect(new URL(url).password).toBe('p%40ss%2Fword')
  })

  it('leaves a pooler URL alone: poolers refuse startup options', () => {
    const url = 'postgresql://u:p@pooler.example.com:6543/db?pgbouncer=true'
    expect(withUtcSession(url)).toBe(url)
  })

  it('returns text that is not a URL as it is', () => {
    expect(withUtcSession('not a url')).toBe('not a url')
    expect(withUtcSession('')).toBe('')
  })
})
