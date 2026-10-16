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

/** Minutes east of UTC that the zone is at `instant` (330 for Asia/Kolkata, -420 for Los Angeles in summer). */
export function utcOffsetMinutes(instant: Date, timeZone: string | null | undefined): number {
  return Math.round(offsetMs(instant, resolveTimeZone(timeZone)) / 60_000)
}

/** The calendar date at `instant` in the zone, as YYYY-MM-DD. */
export function localDateKey(instant: Date, timeZone: string | null | undefined): string {
  const wall = wallClock(instant, resolveTimeZone(timeZone))
  return `${String(wall.year).padStart(4, '0')}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) throw new Error(`not a YYYY-MM-DD date: ${dateKey}`)
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

function dateKeyOf(utcMs: number): string {
  const date = new Date(utcMs)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** `dateKey` plus `days` calendar days (negative to go back). Pure calendar arithmetic: no zone, no daylight saving. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey)
  return dateKeyOf(Date.UTC(year, month - 1, day) + days * DAY)
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetweenDateKeys(from: string, to: string): number {
  const a = parseDateKey(from)
  const b = parseDateKey(to)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY)
}

/**
 * The first instant of the calendar date `dateKey` in the zone. When a zone skips
 * midnight (the clock jumps from 00:00 to 01:00) that is the moment of the jump; when it
 * repeats midnight, the first of the two.
 */
export function localDateStart(dateKey: string, timeZone: string | null | undefined): Date {
  const zone = resolveTimeZone(timeZone)
  const { year, month, day } = parseDateKey(dateKey)
  const midnightAsUtc = Date.UTC(year, month - 1, day)
  // Around the middle of the date, so every offset change that can touch it is within reach.
  const reference = midnightAsUtc + 12 * HOUR

  // The start of the day is "local midnight" under whichever offset applied then.
  // Try the offsets in force around the date and keep the earliest instant that really
  // is the first one of the date.
  const offsets = new Set([-36, -12, 0, 12, 36].map((hours) => offsetMs(new Date(reference + hours * HOUR), zone)))
  const candidates = [...offsets]
    .map((offset) => new Date(midnightAsUtc - offset))
    .filter((candidate) => localDateKey(candidate, zone) === dateKey && localDateKey(new Date(candidate.getTime() - 1), zone) !== dateKey)
    .sort((a, b) => a.getTime() - b.getTime())

  return candidates[0] ?? new Date(midnightAsUtc - offsetMs(new Date(reference), zone))
}

/** The first instant of the calendar day that `now` falls in, in the zone. */
export function localDayStart(now: Date, timeZone: string | null | undefined): Date {
  return localDateStart(localDateKey(now, timeZone), timeZone)
}

/** The first instant of the next calendar day in the zone: when today's quests and caps reset. */
export function localDayEnd(now: Date, timeZone: string | null | undefined): Date {
  return localDateStart(addDaysToDateKey(localDateKey(now, timeZone), 1), timeZone)
}

/** The hour of the day, 0 to 23, at `instant` in the zone. */
export function localHour(instant: Date, timeZone: string | null | undefined): number {
  return wallClock(instant, resolveTimeZone(timeZone)).hour
}

/** ISO weekday of a calendar date: 1 for Monday to 7 for Sunday. */
export function isoWeekdayOfDateKey(dateKey: string): number {
  const { year, month, day } = parseDateKey(dateKey)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

/** The weekday at `instant` in the zone: 1 for Monday to 7 for Sunday. */
export function localIsoWeekday(instant: Date, timeZone: string | null | undefined): number {
  return isoWeekdayOfDateKey(localDateKey(instant, timeZone))
}

/** Saturday and Sunday. */
export function isLocalWeekend(instant: Date, timeZone: string | null | undefined): boolean {
  return localIsoWeekday(instant, timeZone) >= 6
}

/** The Monday of the week (Monday to Sunday) that holds the calendar date. */
export function mondayOfDateKey(dateKey: string): string {
  return addDaysToDateKey(dateKey, 1 - isoWeekdayOfDateKey(dateKey))
}

/** The first instant of the local week (Monday 00:00) that `now` falls in. */
export function localWeekStart(now: Date, timeZone: string | null | undefined): Date {
  return localDateStart(mondayOfDateKey(localDateKey(now, timeZone)), timeZone)
}

/** The first instant of the next local week: when this week's quests reset. */
export function localWeekEnd(now: Date, timeZone: string | null | undefined): Date {
  return localDateStart(addDaysToDateKey(mondayOfDateKey(localDateKey(now, timeZone)), 7), timeZone)
}

/** The ISO 8601 week of a calendar date, as "2026-W42". The year is the week's year, not always the date's. */
export function isoWeekKeyOfDateKey(dateKey: string): string {
  // The week belongs to the year of its Thursday.
  const thursday = addDaysToDateKey(dateKey, 4 - isoWeekdayOfDateKey(dateKey))
  const year = Number(thursday.slice(0, 4))
  const dayOfYear = daysBetweenDateKeys(`${year}-01-01`, thursday)
  return `${year}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')}`
}

/** The ISO week at `instant` in the zone, as "2026-W42". */
export function localWeekKey(instant: Date, timeZone: string | null | undefined): string {
  return isoWeekKeyOfDateKey(localDateKey(instant, timeZone))
}
