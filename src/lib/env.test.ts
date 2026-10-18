import { describe, it, expect, afterEach } from 'vitest'
import { parseEnv, requiresProductionConfig, inMemoryFallbacks, prismaQueryLog, EnvValidationError } from './env'

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

  it('reads the platform settings: entitlements off by default, optional analytics and error reporting', () => {
    const env = parseEnv(base)
    expect(env.ENTITLEMENTS_ENFORCED).toBe(false)
    expect(env.POSTHOG_KEY).toBeUndefined()
    expect(env.POSTHOG_HOST).toBe('https://us.i.posthog.com')
    expect(env.SENTRY_DSN).toBeUndefined()
    expect(env.LOG_LEVEL).toBeUndefined()

    const set = parseEnv({ ...base, ENTITLEMENTS_ENFORCED: 'true', POSTHOG_KEY: 'phc_x', SENTRY_DSN: 'https://k@o1.ingest.sentry.io/42', LOG_LEVEL: 'debug' })
    expect(set.ENTITLEMENTS_ENFORCED).toBe(true)
    expect(set.POSTHOG_KEY).toBe('phc_x')
    expect(set.LOG_LEVEL).toBe('debug')
  })

  it('rejects a switch that is not exactly true or false, without echoing the value', () => {
    const list = problems({ ...base, ENTITLEMENTS_ENFORCED: 'yes-please' })
    expect(list).toEqual(['ENTITLEMENTS_ENFORCED: must be one of: true, false'])
    expect(problems({ ...base, SENTRY_DSN: 'not a url' })).toEqual(['SENTRY_DSN: must be a URL'])
    expect(problems({ ...base, LOG_LEVEL: 'loud' })[0]).toContain('LOG_LEVEL: must be one of')
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

  it('does not echo a value that fails an enum check, which is where Zod quotes it', () => {
    const list = problems({ ...base, NODE_ENV: 'production sk_live_SUPERSECRET' })
    expect(list).toEqual(['NODE_ENV: must be one of: development, test, production'])
  })

  it('requires both halves of a provider credential pair', () => {
    expect(problems({ ...base, UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' })).toEqual([
      'UPSTASH_REDIS_REST_TOKEN: is required when UPSTASH_REDIS_REST_URL is set',
    ])
    expect(problems({ ...production, UPSTASH_REDIS_REST_TOKEN: undefined })).toEqual([
      'UPSTASH_REDIS_REST_TOKEN: is required when UPSTASH_REDIS_REST_URL is set',
    ])
    expect(problems({ ...base, INNGEST_SIGNING_KEY: 'k' })).toEqual([
      'INNGEST_EVENT_KEY: is required when INNGEST_SIGNING_KEY is set',
    ])
  })

  it('reports field problems and cross-setting problems in the same pass', () => {
    const list = problems({ NODE_ENV: 'production', CLERK_SECRET_KEY: 'nope' })
    expect(list).toContain('DATABASE_URL: is required')
    expect(list).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: is required')
    expect(list).toContain('CLERK_SECRET_KEY: must start with sk_')
    expect(list).toContain('ABLY_API_KEY: is required in production')
  })

  it('does not call a malformed setting missing as well', () => {
    const list = problems({ ...production, ABLY_API_KEY: 'not-a-key' })
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('ABLY_API_KEY')
    expect(list[0]).not.toContain('required in production')
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

describe('deployment tiers', () => {
  const SERVICE_SETTINGS = ['CLERK_WEBHOOK_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'ABLY_API_KEY']

  it('stays strict for a Vercel production deployment', () => {
    const list = problems({ ...base, NODE_ENV: 'production', VERCEL_ENV: 'production' })
    for (const name of SERVICE_SETTINGS) expect(list).toContain(`${name}: is required in production`)
  })

  it('stays strict for NODE_ENV=production outside Vercel', () => {
    const list = problems({ ...base, NODE_ENV: 'production' })
    for (const name of SERVICE_SETTINGS) expect(list).toContain(`${name}: is required in production`)
  })

  it('is strict when VERCEL_ENV says production, whatever NODE_ENV says', () => {
    expect(problems({ ...base, NODE_ENV: 'development', VERCEL_ENV: 'production' })).toContain('ABLY_API_KEY: is required in production')
  })

  it('lets a Vercel preview boot without the shared services', () => {
    const preview = parseEnv({ ...base, NODE_ENV: 'production', VERCEL_ENV: 'preview' })
    expect(preview.VERCEL_ENV).toBe('preview')
    expect(preview.UPSTASH_REDIS_REST_URL).toBeUndefined()
    expect(preview.ABLY_API_KEY).toBeUndefined()
  })

  it('still validates what is set on a preview', () => {
    const list = problems({ ...base, NODE_ENV: 'production', VERCEL_ENV: 'preview', ABLY_API_KEY: 'not-a-key' })
    expect(list).toEqual(['ABLY_API_KEY: must look like appId.keyId:secret'])
  })

  it('still requires credential pairs to be set together on a preview', () => {
    const list = problems({ ...base, NODE_ENV: 'production', VERCEL_ENV: 'preview', UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' })
    expect(list).toEqual(['UPSTASH_REDIS_REST_TOKEN: is required when UPSTASH_REDIS_REST_URL is set'])
  })

  it('still requires the base settings on a preview', () => {
    expect(problems({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toEqual(
      expect.arrayContaining(['DATABASE_URL: is required', 'CLERK_SECRET_KEY: is required'])
    )
  })

  it('rejects an unknown VERCEL_ENV without echoing it', () => {
    const list = problems({ ...base, VERCEL_ENV: 'staging-sk_live_SECRET' })
    expect(list).toEqual(['VERCEL_ENV: must be one of: production, preview, development'])
  })

  it('decides strictness from VERCEL_ENV first, then NODE_ENV', () => {
    expect(requiresProductionConfig({ VERCEL_ENV: 'production' })).toBe(true)
    expect(requiresProductionConfig({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(false)
    expect(requiresProductionConfig({ VERCEL_ENV: 'development', NODE_ENV: 'production' })).toBe(false)
    expect(requiresProductionConfig({ NODE_ENV: 'production' })).toBe(true)
    expect(requiresProductionConfig({ NODE_ENV: 'development' })).toBe(false)
    expect(requiresProductionConfig({})).toBe(false)
  })

  it('lists the services a configuration is running without', () => {
    expect(inMemoryFallbacks(parseEnv(production))).toEqual([])
    const preview = inMemoryFallbacks(parseEnv({ ...base, NODE_ENV: 'production', VERCEL_ENV: 'preview', ABLY_API_KEY: 'appId.keyId:secret' }))
    expect(preview).toHaveLength(3)
    expect(preview.join('\n')).toContain('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
    expect(preview.join('\n')).toContain('INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY not set')
    expect(preview.join('\n')).toContain('CLERK_WEBHOOK_SECRET not set')
    expect(preview.join('\n')).not.toContain('ABLY_API_KEY not set')
  })
})

describe('PRISMA_QUERY_LOG', () => {
  const original = process.env.PRISMA_QUERY_LOG
  afterEach(() => {
    if (original === undefined) delete process.env.PRISMA_QUERY_LOG
    else process.env.PRISMA_QUERY_LOG = original
  })

  it('is on unless it says off, and is read when asked, so a script can switch it off after its imports', () => {
    delete process.env.PRISMA_QUERY_LOG
    expect(prismaQueryLog()).toBe('on')
    process.env.PRISMA_QUERY_LOG = 'off'
    expect(prismaQueryLog()).toBe('off')
    process.env.PRISMA_QUERY_LOG = 'nonsense'
    expect(prismaQueryLog()).toBe('on')
  })

  it('is validated at boot like every other setting', () => {
    expect(parseEnv({ ...base, PRISMA_QUERY_LOG: 'off' }).PRISMA_QUERY_LOG).toBe('off')
    expect(problems({ ...base, PRISMA_QUERY_LOG: 'maybe' }).join('\n')).toContain('PRISMA_QUERY_LOG')
  })
})

describe('object storage settings', () => {
  const storage = {
    STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    STORAGE_BUCKET: 'skill-dating',
    STORAGE_ACCESS_KEY_ID: 'akid',
    STORAGE_SECRET_ACCESS_KEY: 'secret',
  }

  it('is optional, and the region defaults to auto', () => {
    const env = parseEnv(base)
    expect(env.STORAGE_ENDPOINT).toBeUndefined()
    expect(env.STORAGE_REGION).toBe('auto')
    expect(parseEnv({ ...base, ...storage, STORAGE_REGION: 'eu-west-1', STORAGE_PUBLIC_BASE_URL: 'https://cdn.example.com' })).toMatchObject({ STORAGE_REGION: 'eu-west-1', STORAGE_PUBLIC_BASE_URL: 'https://cdn.example.com' })
  })

  it('is not required in production: without it uploads are refused, not the boot', () => {
    expect(() => parseEnv(production)).not.toThrow()
  })

  it('needs all four settings together', () => {
    expect(problems({ ...base, STORAGE_ENDPOINT: storage.STORAGE_ENDPOINT })).toEqual(
      expect.arrayContaining(['STORAGE_BUCKET: is required when STORAGE_ENDPOINT is set', 'STORAGE_ACCESS_KEY_ID: is required when STORAGE_ENDPOINT is set'])
    )
    expect(problems({ ...base, STORAGE_ACCESS_KEY_ID: 'akid' })).toEqual(expect.arrayContaining(['STORAGE_SECRET_ACCESS_KEY: is required when STORAGE_ACCESS_KEY_ID is set']))
    expect(problems({ ...base, STORAGE_SECRET_ACCESS_KEY: 'secret' })).toEqual(expect.arrayContaining(['STORAGE_ACCESS_KEY_ID: is required when STORAGE_SECRET_ACCESS_KEY is set']))
  })

  it('never puts a secret in a problem message', () => {
    const found = problems({ ...base, ...storage, STORAGE_ENDPOINT: 'not a url' }).join('\n')
    expect(found).toContain('STORAGE_ENDPOINT')
    expect(found).not.toContain('secret')
  })
})
