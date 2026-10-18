import { addDaysToDateKey, isoWeekdayOfDateKey, isoWeekKeyOfDateKey, localDateKey, localDateStart } from './time'

// Ship Day is Friday, in the viewer's own time zone: the weekly moment when everyone shows what they shipped. Pure date arithmetic (src/lib/time.ts
// knows the zone rules). A post made during someone's local Friday is a Ship Day post; the week it belongs to is the ISO week of that Friday, so the
// recap of "this week's Ship Day" is the same whatever zone the author is in.

export const SHIP_DAY_WEEKDAY = 5 // ISO: Friday
/** The tag every Ship Day post carries. */
export const SHIP_DAY_TAG = 'ship-day'
/** The recap job runs Saturday at this UTC hour: UTC-12, the last zone to leave Friday, is into Saturday from 12:00 UTC. */
export const SHIP_DAY_RECAP_UTC_HOUR = 12

export interface ShipDayStatus {
  isShipDay: boolean
  /** The local date of this week's Ship Day, "YYYY-MM-DD". */
  dateKey: string
  /** The ISO week it belongs to, "2026-W42". */
  weekKey: string
  /** When it starts and ends (the start of Saturday) for this viewer. */
  startsAt: Date
  endsAt: Date
}

/** The Friday of the ISO week that holds the calendar date. */
export const fridayOfDateKey = (dateKey: string): string => addDaysToDateKey(dateKey, SHIP_DAY_WEEKDAY - isoWeekdayOfDateKey(dateKey))

/** Whether `dateKey` is a Friday. */
export const isFridayKey = (dateKey: string): boolean => isoWeekdayOfDateKey(dateKey) === SHIP_DAY_WEEKDAY

/**
 * This week's Ship Day for a viewer: the Friday of the week they are in (Monday to Sunday, in their zone), whether it is today, and when it starts and ends. On a Saturday
 * or Sunday that Friday is already behind them (`isShipDay` false, and `endsAt` in the past); the response says so honestly rather than skipping ahead.
 */
export function shipDayFor(now: Date, timeZone: string | null | undefined): ShipDayStatus {
  const today = localDateKey(now, timeZone)
  const dateKey = fridayOfDateKey(today)
  return {
    isShipDay: today === dateKey,
    dateKey,
    weekKey: isoWeekKeyOfDateKey(dateKey),
    startsAt: localDateStart(dateKey, timeZone),
    endsAt: localDateStart(addDaysToDateKey(dateKey, 1), timeZone),
  }
}

/** The local Friday a post made at `createdAt` belongs to, or null when it was not made on a Friday. */
export function shipDayKeyOf(createdAt: Date, timeZone: string | null | undefined): string | null {
  const day = localDateKey(createdAt, timeZone)
  return isFridayKey(day) ? day : null
}
