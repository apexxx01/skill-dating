// Every database session runs in UTC. The DateTime columns are `timestamp` (no zone) and hold UTC, and
// Postgres converts between that and `timestamptz` through the SESSION time zone, so a session in any other zone
// shifts every comparison and every write that goes through such a conversion. The raw queries guard against
// it themselves (src/lib/sql.ts); this makes the session itself UTC, so a query that forgets still comes out right.
//
// Three layers, each covering what the one before cannot:
//  1. the queries convert explicitly (utcTimestamp);
//  2. the app's connections ask for UTC when they open (this file), unless the URL goes through a pooler in
//     transaction mode, which rejects session settings;
//  3. the database's own default is UTC (the migration `database_utc_default`), which also covers pooled connections.

const TIMEZONE_SETTING = /(?:^|\s)(?:-c\s*|--)timezone=\S+/gi

/**
 * `databaseUrl` with the session time zone set to UTC through the `options` connection parameter. Any time
 * zone already requested in `options` is replaced; other options are kept. A URL for a connection pooler
 * (`pgbouncer=true`) is returned as it is, because poolers refuse startup options; the database default covers those.
 * A string that is not a URL is returned untouched.
 */
export function withUtcSession(databaseUrl: string): string {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    return databaseUrl
  }
  if (url.searchParams.get('pgbouncer') === 'true') return databaseUrl

  const params: [string, string][] = []
  let options = ''
  for (const [key, value] of url.searchParams) {
    if (key === 'options') options = value
    else params.push([key, value])
  }
  const kept = options.replace(TIMEZONE_SETTING, '').trim()
  params.push(['options', `${kept ? `${kept} ` : ''}-c timezone=UTC`])

  // Spaces as %20: that is what the engine's URL parser reads back as a space in every driver version.
  url.search = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
  return url.toString()
}
