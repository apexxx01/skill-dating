import { afterEach, describe, expect, it, vi } from 'vitest'

// The scanner is chosen from the environment when it is first asked for, so each case sets the variables and imports fresh copies of the modules.
async function load(nodeEnv: string, vars: Record<string, string | undefined>) {
  vi.resetModules()
  const saved = { ...process.env }
  Object.assign(process.env, { NODE_ENV: nodeEnv })
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const moderation = await import('./media-moderation')
  const env = await import('@/lib/env')
  env.resetEnvCache()
  return { moderation, restore: () => (process.env = saved) }
}

// What a production deployment must have, so that the environment is valid and only the scanner varies.
const required = { CLERK_WEBHOOK_SECRET: 'whsec_x', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't', INNGEST_EVENT_KEY: 'e', INNGEST_SIGNING_KEY: 's', ABLY_API_KEY: 'a.b:c' }
const base = { ...required, DATABASE_URL: 'postgresql://u:p@localhost:5432/x', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x', INTEGRATION_TEST_SERVER: undefined }

describe('the media scanner in production', () => {
  let restore = () => {}
  afterEach(() => restore())

  it('fails closed without a provider: unavailable, and a scan throws, so nothing is ever served unscanned', async () => {
    const loaded = await load('production', { ...base, VERCEL_ENV: 'production', MEDIA_MODERATION_URL: undefined, MEDIA_MODERATION_TOKEN: undefined })
    restore = loaded.restore
    const scanner = loaded.moderation.createMediaScanner()
    expect(scanner.kind).toBe('unavailable')
    expect(scanner.available).toBe(false)
    await expect(scanner.scan({} as never)).rejects.toThrow()
  })

  it('fails closed on a preview too (only the integration harness may use the stand-in)', async () => {
    const loaded = await load('production', { ...base, VERCEL_ENV: 'preview', MEDIA_MODERATION_URL: undefined, MEDIA_MODERATION_TOKEN: undefined })
    restore = loaded.restore
    expect(loaded.moderation.createMediaScanner().kind).toBe('unavailable')
  })

  it('uses the provider when both settings are set', async () => {
    const loaded = await load('production', { ...base, VERCEL_ENV: 'production', MEDIA_MODERATION_URL: 'https://scan.example.com/scan', MEDIA_MODERATION_TOKEN: 't' })
    restore = loaded.restore
    expect(loaded.moderation.createMediaScanner().kind).toBe('http')
  })

  it('treats everything as safe only outside production', async () => {
    const loaded = await load('development', { ...base, VERCEL_ENV: undefined, MEDIA_MODERATION_URL: undefined, MEDIA_MODERATION_TOKEN: undefined })
    restore = loaded.restore
    expect(loaded.moderation.createMediaScanner().kind).toBe('noop')
  })
})
