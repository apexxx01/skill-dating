import { Prisma } from '@prisma/client'

/**
 * A date to compare with a `DateTime` column in raw SQL. The columns are `timestamp` (no zone) holding UTC, while a
 * `Date` parameter arrives as `timestamptz`, so comparing the two directly reads the column in the session's
 * time zone: right on a UTC server, hours off on any other. This turns the parameter into the same kind of
 * value as the column.
 */
export const utcTimestamp = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`
