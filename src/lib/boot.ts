import { EnvValidationError, nodeEnv, validateEnv, type Env } from '@/lib/env'

// Called once when the server starts (src/instrumentation.ts).
//
// In production an invalid environment must end the process. Next's `next start`
// only logs an error thrown while it prepares the server and then keeps
// listening, answering every request with a 500: a process that looks alive to a
// supervisor or a health check on the port, and so is never restarted or rolled
// back. Exiting non-zero is what makes a bad deploy visibly fail. In development
// the error is thrown instead, so the dev server stays up to pick up a fixed
// .env.local.
export function validateEnvOrExit(
  exit: (code: number) => never = (code) => process.exit(code),
  log: (message: string) => void = (message) => console.error(message)
): Env {
  try {
    return validateEnv()
  } catch (error) {
    log(error instanceof EnvValidationError ? error.message : `Could not read the environment: ${String(error)}`)
    if (nodeEnv === 'production') return exit(1)
    throw error
  }
}
