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
})
