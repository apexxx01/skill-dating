import { addDaysToDateKey, localDateKey, localDateStart, localTimeKey } from '@/lib/time'

// Quiet hours: a stretch of the person's own night (minutes after local midnight) when nothing is pushed or mailed, except account and safety notices. It may cross
// midnight (22:00 to 08:00). Equal start and end means no quiet hours.

const MINUTE_MS = 60_000

export interface QuietWindow {
  enabled: boolean
  /** Minutes after local midnight, 0 to 1439. */
  start: number
  end: number
}

export function minutesOfDay(instant: Date, timeZone: string | null | undefined): number {
  const [hours, minutes] = localTimeKey(instant, timeZone).split(':').map(Number)
  return hours * 60 + minutes
}

export function inQuietHours(now: Date, timeZone: string | null | undefined, window: QuietWindow): boolean {
  if (!window.enabled || window.start === window.end) return false
  const minute = minutesOfDay(now, timeZone)
  return window.start < window.end ? minute >= window.start && minute < window.end : minute >= window.start || minute < window.end
}

/** The next moment quiet hours end, in the person's time zone. */
export function quietEndsAt(now: Date, timeZone: string | null | undefined, window: QuietWindow): Date {
  const today = localDateKey(now, timeZone)
  const todaysEnd = new Date(localDateStart(today, timeZone).getTime() + window.end * MINUTE_MS)
  if (todaysEnd.getTime() > now.getTime()) return todaysEnd
  return new Date(localDateStart(addDaysToDateKey(today, 1), timeZone).getTime() + window.end * MINUTE_MS)
}

/** "22:00" for 1320: how a clock time is given to and by the API. */
export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
