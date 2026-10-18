-- Every session of this database runs in UTC. The DateTime columns are `timestamp` (no zone) and hold UTC;
-- any conversion to or from `timestamptz` goes through the session time zone, so a database configured in
-- another zone would shift them. The queries convert explicitly and the application asks for a UTC session
-- on every connection (src/lib/database-url.ts); this makes the database default UTC as well, which also
-- covers connections that go through a pooler, where session settings cannot be sent.
--
-- It needs to own the database. Where the role may not change it, the migration still succeeds: the two other layers hold.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not set the database time zone to UTC (insufficient privilege); sessions rely on the connection option';
END
$$;
