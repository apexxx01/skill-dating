import { afterEach, describe, expect, it, vi } from 'vitest'

// nodeEnv is read once when env.ts loads, so each case sets NODE_ENV first and
// imports fresh copies of the modules.
async function load(nodeEnv: string, vars: Record<string, string | undefined>) {
  vi.resetModules()
  const saved = { ...process.env }
  Object.assign(process.env, { NODE_ENV: nodeEnv })
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const boot = await import('./boot')
  const env = await import('./env')
  env.resetEnvCache()
  return { boot, restore: () => (process.env = saved) }
}

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/x',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
  CLERK_SECRET_KEY: 'sk_test_x',
}

describe('validateEnvOrExit', () => {
  let restore = () => {}
  afterEach(() => restore())

  it('returns the environment when it is valid', async () => {
    const loaded = await load('development', valid)
    restore = loaded.restore
    const exit = vi.fn() as never
    expect(loaded.boot.validateEnvOrExit(exit, () => {}).DATABASE_URL).toBe(valid.DATABASE_URL)
    expect(exit).not.toHaveBeenCalled()
  })

  it('in production logs every problem and exits with a failure code', async () => {
    const loaded = await load('production', { ...valid, DATABASE_URL: undefined, CLERK_WEBHOOK_SECRET: undefined })
    restore = loaded.restore
    const log = vi.fn()
    const exit = vi.fn(() => {
      throw new Error('exit called')
    }) as never
    expect(() => loaded.boot.validateEnvOrExit(exit, log)).toThrow('exit called')
    expect(exit).toHaveBeenCalledWith(1)
    const logged = log.mock.calls[0][0] as string
    expect(logged).toContain('DATABASE_URL: is required')
    expect(logged).toContain('CLERK_WEBHOOK_SECRET: is required in production')
  })

  it('in development throws instead, so the dev server stays up for a fixed .env.local', async () => {
    const loaded = await load('development', { ...valid, CLERK_SECRET_KEY: 'bad' })
    restore = loaded.restore
    const exit = vi.fn() as never
    expect(() => loaded.boot.validateEnvOrExit(exit, () => {})).toThrow('CLERK_SECRET_KEY: must start with sk_')
    expect(exit).not.toHaveBeenCalled()
  })

  it('does not put a value in the log', async () => {
    const loaded = await load('production', { ...valid, CLERK_SECRET_KEY: 'wrong-SECRETVALUE123' })
    restore = loaded.restore
    const log = vi.fn()
    expect(() => loaded.boot.validateEnvOrExit((() => { throw new Error('x') }) as never, log)).toThrow()
    expect(log.mock.calls[0][0]).not.toContain('SECRETVALUE123')
  })

  it('boots a preview on the in-memory fallbacks and says so loudly', async () => {
    const loaded = await load('production', { ...valid, VERCEL_ENV: 'preview', CLERK_WEBHOOK_SECRET: undefined, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, INNGEST_EVENT_KEY: undefined, INNGEST_SIGNING_KEY: undefined, ABLY_API_KEY: undefined })
    restore = loaded.restore
    const exit = vi.fn() as never
    const warn = vi.fn()
    const config = loaded.boot.validateEnvOrExit(exit, () => {}, warn)
    expect(config.VERCEL_ENV).toBe('preview')
    expect(exit).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0] as string
    expect(message).toContain('WARNING: starting on in-memory fallbacks (VERCEL_ENV=preview)')
    for (const name of ['UPSTASH_REDIS_REST_URL', 'INNGEST_EVENT_KEY', 'ABLY_API_KEY', 'CLERK_WEBHOOK_SECRET']) expect(message).toContain(name)
    expect(message).not.toContain(valid.CLERK_SECRET_KEY)
  })

  it('still exits for a production deployment missing the same services', async () => {
    const loaded = await load('production', { ...valid, VERCEL_ENV: 'production', CLERK_WEBHOOK_SECRET: undefined, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, INNGEST_EVENT_KEY: undefined, INNGEST_SIGNING_KEY: undefined, ABLY_API_KEY: undefined })
    restore = loaded.restore
    const exit = vi.fn(() => { throw new Error('exit') }) as never
    const warn = vi.fn()
    expect(() => loaded.boot.validateEnvOrExit(exit, () => {}, warn)).toThrow('exit')
    expect(exit).toHaveBeenCalledWith(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn in development, where the stand-ins are the default', async () => {
    const loaded = await load('development', { ...valid, VERCEL_ENV: undefined })
    restore = loaded.restore
    const warn = vi.fn()
    loaded.boot.validateEnvOrExit(vi.fn() as never, () => {}, warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn when production has every service', async () => {
    const loaded = await load('production', {
      ...valid,
      VERCEL_ENV: 'production',
      CLERK_WEBHOOK_SECRET: 'whsec_x',
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 't',
      INNGEST_EVENT_KEY: 'e',
      INNGEST_SIGNING_KEY: 's',
      ABLY_API_KEY: 'a.b:c',
    })
    restore = loaded.restore
    const warn = vi.fn()
    loaded.boot.validateEnvOrExit(vi.fn() as never, () => {}, warn)
    expect(warn).not.toHaveBeenCalled()
  })
})
