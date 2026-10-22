// Runs once when the server starts. A missing or malformed setting stops the
// server here, with every problem listed, instead of failing the first request
// that needs it (see src/lib/boot.ts for what "stops" means in production).
// `next build` does not run this, so a build needs no secrets.
//
// With SENTRY_DSN set it also starts error reporting for the runtime it runs in
// (docs/DEPLOY.md, "Error reporting with Sentry"). Without a DSN the SDK is never loaded.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnvOrExit } = await import('@/lib/boot')
    validateEnvOrExit()
    if (process.env.SENTRY_DSN) await import('../sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge' && process.env.SENTRY_DSN) {
    await import('../sentry.edge.config')
  }
}

/** Errors Next catches while rendering or running a request, handed to Sentry when reporting is on. */
export async function onRequestError(...args: unknown[]) {
  if (!process.env.SENTRY_DSN) return
  const Sentry = await import('@sentry/nextjs')
  return (Sentry.captureRequestError as (...a: unknown[]) => unknown)(...args)
}
