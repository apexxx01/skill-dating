// Time zones. Everything is stored in UTC; a "day" for a person is a calendar day
// in THEIR time zone (User.timezone, an IANA name such as "Asia/Kolkata"),
// falling back to UTC when it is missing or not a zone this runtime knows.
// No offsets are hard-coded: the runtime's tz database knows the daylight saving
// rules, so days that are 23 or 25 hours long, half-hour zones and midnights that
// do not exist all come out right.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone || timeZone.length > 64) return false
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

/** The zone to use for a user: their own when it is valid, UTC otherwise. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC'
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const values: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

/** Milliseconds to add to UTC to get the wall clock in `timeZone` at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** The calendar date at `instant` in the zone, as YYYY-MM-DD. */
export function localDateKey(instant: Date, timeZone: string | null | undefined): string {
  const wall = wallClock(instant, resolveTimeZone(timeZone))
  return `${String(wall.year).padStart(4, '0')}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`
}

const HOUR = 3_600_000

/**
 * The first instant of the calendar day that `now` falls in, in the zone. When
 * a zone skips midnight (the clock jumps from 00:00 to 01:00) that is the moment
 * of the jump; when it repeats midnight, the first of the two.
 */
export function localDayStart(now: Date, timeZone: string | null | undefined): Date {
  const zone = resolveTimeZone(timeZone)
  const wall = wallClock(now, zone)
  const midnightAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day)
  const target = localDateKey(now, zone)

  // The start of the day is "local midnight" under whichever offset applied then.
  // Try the offsets in force around now and keep the earliest instant that really
  // is the first one of the date.
  const offsets = new Set([-36, -12, 0, 12, 36].map((hours) => offsetMs(new Date(now.getTime() + hours * HOUR), zone)))
  const candidates = [...offsets]
    .map((offset) => new Date(midnightAsUtc - offset))
    .filter((candidate) => localDateKey(candidate, zone) === target && localDateKey(new Date(candidate.getTime() - 1), zone) !== target)
    .sort((a, b) => a.getTime() - b.getTime())

  return candidates[0] ?? new Date(midnightAsUtc - offsetMs(now, zone))
}
