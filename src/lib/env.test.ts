import { describe, it, expect } from 'vitest'
import { parseEnv, EnvValidationError } from './env'

const base = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/skill_dating?schema=public',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_abc',
  CLERK_SECRET_KEY: 'sk_test_abc',
}

const production = {
  ...base,
  NODE_ENV: 'production',
  CLERK_WEBHOOK_SECRET: 'whsec_abc',
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  INNGEST_EVENT_KEY: 'event-key',
  INNGEST_SIGNING_KEY: 'signing-key',
  ABLY_API_KEY: 'appId.keyId:secret',
}

function problems(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source)
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError)
    return (error as EnvValidationError).problems
  }
  throw new Error('expected parseEnv to throw')
}

describe('parseEnv', () => {
  it('accepts the minimum development configuration and applies defaults', () => {
    const env = parseEnv(base)
    expect(env.NODE_ENV).toBe('development')
    expect(env.TRUSTED_PROXY_HOPS).toBe(0)
    expect(env.CLERK_AUTHORIZED_PARTIES).toEqual([])
    expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined()
  })

  it('treats empty strings as unset, so a copied .env.example parses', () => {
    const env = parseEnv({ ...base, CLERK_WEBHOOK_SECRET: '', CLERK_AUTHORIZED_PARTIES: '', ABLY_API_KEY: '  ', TRUSTED_PROXY_HOPS: '' })
    expect(env.CLERK_WEBHOOK_SECRET).toBeUndefined()
    expect(env.ABLY_API_KEY).toBeUndefined()
    expect(env.TRUSTED_PROXY_HOPS).toBe(0)
  })

  it('parses numbers and lists', () => {
    const env = parseEnv({ ...base, TRUSTED_PROXY_HOPS: '2', CLERK_AUTHORIZED_PARTIES: 'https://a.example, https://b.example ,' })
    expect(env.TRUSTED_PROXY_HOPS).toBe(2)
    expect(env.CLERK_AUTHORIZED_PARTIES).toEqual(['https://a.example', 'https://b.example'])
  })

  it('reports every missing required setting at once', () => {
    const list = problems({})
    expect(list).toHaveLength(3)
    expect(list.join('\n')).toContain('DATABASE_URL')
    expect(list.join('\n')).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
    expect(list.join('\n')).toContain('CLERK_SECRET_KEY')
  })

  it('rejects malformed values', () => {
    expect(problems({ ...base, DATABASE_URL: 'mysql://x/y' })).toEqual(['DATABASE_URL: must be a postgresql:// URL'])
    expect(problems({ ...base, CLERK_SECRET_KEY: 'nope' })).toEqual(['CLERK_SECRET_KEY: must start with sk_'])
    expect(problems({ ...base, TRUSTED_PROXY_HOPS: '-1' })[0]).toContain('TRUSTED_PROXY_HOPS')
    expect(problems({ ...base, TRUSTED_PROXY_HOPS: 'many' })[0]).toContain('TRUSTED_PROXY_HOPS')
    expect(problems({ ...base, NODE_ENV: 'staging' })[0]).toContain('NODE_ENV')
    expect(problems({ ...base, ABLY_API_KEY: 'not-a-key' })[0]).toContain('ABLY_API_KEY')
  })

  it('never puts a value in the error message', () => {
    const error = (() => {
      try {
        parseEnv({ ...base, CLERK_SECRET_KEY: 'wrong-prefix-SUPERSECRETVALUE', DATABASE_URL: 'mysql://user:hunter2@host/db' })
      } catch (e) {
        return e as Error
      }
      throw new Error('expected a throw')
    })()
    expect(error.message).not.toContain('SUPERSECRETVALUE')
    expect(error.message).not.toContain('hunter2')
  })

  it('requires both halves of a provider credential pair', () => {
    expect(problems({ ...base, UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' })).toEqual([
      'UPSTASH_REDIS_REST_TOKEN: is required when UPSTASH_REDIS_REST_URL is set',
    ])
    expect(problems({ ...base, INNGEST_SIGNING_KEY: 'k' })).toEqual([
      'INNGEST_EVENT_KEY: is required when INNGEST_SIGNING_KEY is set',
    ])
  })

  it('accepts a complete production configuration', () => {
    expect(parseEnv(production).NODE_ENV).toBe('production')
  })

  it('requires the shared services in production, and only there', () => {
    const list = problems({ ...base, NODE_ENV: 'production' })
    for (const name of ['CLERK_WEBHOOK_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'ABLY_API_KEY']) {
      expect(list).toContain(`${name}: is required in production`)
    }
    expect(() => parseEnv({ ...base, NODE_ENV: 'test' })).not.toThrow()
  })
})
