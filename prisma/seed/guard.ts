import fs from 'fs'
import path from 'path'

// What the seed refuses, and how it reads its settings. It makes thousands of synthetic people: it must never touch a real database.

export class SeedRefusal extends Error {}

/** Loads .env.local then .env into process.env without overriding what is already set, and prints nothing. */
export function loadEnvFiles(root: string = path.resolve(__dirname, '../..')): void {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match || process.env[match[1]] !== undefined) continue
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal', 'postgres', 'db'])

/** The host and database name of a connection string, for messages. Never the credentials. */
export function describeDatabase(url: string | undefined): { host: string; database: string } | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return { host: parsed.hostname, database: parsed.pathname.replace(/^\//, '') }
  } catch {
    return null
  }
}

/**
 * Throws unless it is safe to fill this database with synthetic people: not a production environment (NODE_ENV, VERCEL_ENV), and a database on this machine (or one the caller
 * names with ALLOW_SEED_ON_REMOTE=1, for a disposable preview database; never accepted in production).
 */
export function assertSafeToSeed(env: NodeJS.ProcessEnv = process.env): { host: string; database: string } {
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') {
    throw new SeedRefusal('Refusing to seed: this is a production environment (NODE_ENV or VERCEL_ENV says production).')
  }
  const database = describeDatabase(env.DATABASE_URL)
  if (!database) throw new SeedRefusal('Refusing to seed: DATABASE_URL is not set or is not a connection string.')
  if (!LOCAL_HOSTS.has(database.host) && env.ALLOW_SEED_ON_REMOTE !== '1') {
    throw new SeedRefusal(`Refusing to seed ${database.host}/${database.database}: it is not on this machine. Set ALLOW_SEED_ON_REMOTE=1 only for a disposable preview database.`)
  }
  return database
}
