// Runs once when the server starts. A missing or malformed setting stops the
// server here, with every problem listed, instead of failing the first request
// that needs it (see src/lib/boot.ts for what "stops" means in production).
// `next build` does not run this, so a build needs no secrets.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnvOrExit } = await import('@/lib/boot')
    validateEnvOrExit()
  }
}
