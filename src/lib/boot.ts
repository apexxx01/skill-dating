import { EnvValidationError, inMemoryFallbacks, missingProviders, nodeEnv, requiresProductionConfig, validateEnv, type Env } from '@/lib/env'

// Called once when the server starts (src/instrumentation.ts).
//
// In production an invalid environment must end the process. Next's `next start`
// only logs an error thrown while it prepares the server and then keeps
// listening, answering every request with a 500: a process that looks alive to a
// supervisor or a health check on the port, and so is never restarted or rolled
// back. Exiting non-zero is what makes a bad deploy visibly fail. In development
// the error is thrown instead, so the dev server stays up to pick up a fixed
// .env.local.
// A deployed process (NODE_ENV=production) that got past validation yet is
// missing a service can only be a Vercel preview, since production requires
// them all. It is allowed to run on the in-memory stand-ins, but not quietly.
// Development and tests use the stand-ins by design and are not warned.
// A deployment that has every required service can still lack the optional ones (mail, push, storage, media scanning, error reporting): they have stand-ins or refuse
// the feature, so nothing stops, and a quiet start would hide it. They are listed by name with what is lost (never a value). In production GET /api/health says "degraded"
// while any is missing.
function warnOnFallbacks(config: Env, warn: (message: string) => void) {
  if (config.NODE_ENV !== 'production') return
  const fallbacks = inMemoryFallbacks(config)
  const missing = missingProviders(config)
  if (fallbacks.length === 0 && missing.length === 0) return
  const rule = '='.repeat(72)
  const lines = [rule]
  if (fallbacks.length > 0) {
    lines.push(`WARNING: starting on in-memory fallbacks (VERCEL_ENV=${config.VERCEL_ENV ?? 'unset'}).`, ...fallbacks.map((line) => `  - ${line}`))
    lines.push('Acceptable for a preview deployment only: a production deployment refuses to start without these.')
  }
  if (missing.length > 0) {
    const production = requiresProductionConfig({ VERCEL_ENV: config.VERCEL_ENV, NODE_ENV: config.NODE_ENV })
    lines.push(`WARNING: ${missing.length} provider${missing.length === 1 ? ' is' : 's are'} not configured${production ? ' in PRODUCTION (GET /api/health reports "degraded" until they are)' : ''}:`)
    lines.push(...missing.map((provider) => `  - ${provider.name} (${provider.settings.join(', ')} not set): ${provider.effect}`))
  }
  lines.push(rule)
  warn(lines.join('\n'))
}

export function validateEnvOrExit(
  exit: (code: number) => never = (code) => process.exit(code),
  log: (message: string) => void = (message) => console.error(message),
  warn: (message: string) => void = (message) => console.warn(message)
): Env {
  try {
    const config = validateEnv()
    warnOnFallbacks(config, warn)
    return config
  } catch (error) {
    log(error instanceof EnvValidationError ? error.message : `Could not read the environment: ${String(error)}`)
    if (nodeEnv === 'production') return exit(1)
    throw error
  }
}
