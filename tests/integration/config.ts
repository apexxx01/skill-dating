// Everything a test run needs to know about where it runs, from the
// environment, so several runs (for example parallel branches, each in its own
// checkout) never share a database or a port:
//
//   TEST_PORT          port for the spawned dev server        (default 3459)
//   TEST_DB_NAME       database name on the server below       (default skill_dating_integration)
//   TEST_DB_BASE_URL   server, credentials, no database name   (default postgresql://postgres:postgres@localhost:5432)
//
// Runs also need separate checkouts (or at least separate build output
// directories): two dev servers writing to one .next directory corrupt each
// other regardless of port.
const DEFAULT_PORT = 3459

function readPort(): number {
  const raw = process.env.TEST_PORT
  if (!raw) return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`TEST_PORT must be an integer between 1024 and 65535, got "${raw}"`)
  }
  return port
}

function readDbName(): string {
  const name = process.env.TEST_DB_NAME || 'skill_dating_integration'
  // The name ends up in a connection string and is created by db push, so
  // keep it to safe identifier characters.
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`TEST_DB_NAME may only contain letters, digits and underscores, got "${name}"`)
  }
  if (name === 'skill_dating') {
    throw new Error('TEST_DB_NAME must not be the shared development database "skill_dating"')
  }
  return name
}

export const INTEGRATION_PORT = readPort()
export const INTEGRATION_BASE_URL = `http://localhost:${INTEGRATION_PORT}`
export const INTEGRATION_DB_NAME = readDbName()
const dbBase = (process.env.TEST_DB_BASE_URL || 'postgresql://postgres:postgres@localhost:5432').replace(/\/+$/, '')
export const INTEGRATION_DATABASE_URL = `${dbBase}/${INTEGRATION_DB_NAME}?schema=public`
