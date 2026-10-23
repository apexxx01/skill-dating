// The names of the flags that gate the romance mode, in a module of their own with no imports (src/lib/flags.ts reads them, and src/lib/romance/launch.ts reads flags).

export const ROMANCE_LAUNCH_FLAG = 'romance.enabled'
export const ROMANCE_CITY_FLAG_PREFIX = 'romance.city.'
/** The kill switch for the mode (src/lib/ops/kill-switches.ts uses this same key). */
export const ROMANCE_KILL_FLAG = 'kill.romance'

/** Flags that belong to the launch gate: not listed in GET /api/flags, whose answers the interface reads. */
export const isLaunchGateFlag = (key: string): boolean => key === ROMANCE_LAUNCH_FLAG || key.startsWith(ROMANCE_CITY_FLAG_PREFIX) || key === ROMANCE_KILL_FLAG
