// Runs once when the server starts. A missing or malformed setting stops the
// process here, with every problem listed, instead of failing the first request
// that needs it. `next build` does not run this, so a build needs no secrets.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('@/lib/env')
    validateEnv()
  }
}
