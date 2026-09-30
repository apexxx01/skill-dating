import path from 'path'
import fs from 'fs'

// Next.js does not auto-load .env.local when NODE_ENV=test (a deliberate
// Next.js safety default, so a test run never silently picks up dev
// secrets) - and vitest sets NODE_ENV=test. So the spawned dev server, and the
// helpers that call the Clerk Backend API directly, read it explicitly.
export function loadEnvLocal(projectRoot: string = path.resolve(__dirname, '../..')): Record<string, string> {
  const envPath = path.join(projectRoot, '.env.local')
  const vars: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return vars
  const contents = fs.readFileSync(envPath, 'utf-8')
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return vars
}
