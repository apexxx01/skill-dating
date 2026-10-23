import { SeedRefusal } from './guard'

export interface SeedArgs {
  /** People in the world. 400 by default; more adds background people written in bulk (docs/PERFORMANCE.md). */
  scale: number
  /** The seed of the random generator. */
  seed: string
  /** Delete the seeded world first and build it again. */
  reset: boolean
  /** Also make the synthetic romance-mode people. */
  withRomance: boolean
  /** seed:demo: the username of the demo account. */
  username: string | null
  /** How many days of history. */
  days: number
  help: boolean
}

export const DEFAULTS = { scale: 400, seed: 'skill-dating-world-1', days: 75 } as const

/** Parses `--scale 10000 --seed x --reset --with-romance --username aanya --days 75` (also `--scale=10000`). Pure. */
export function parseArgs(argv: readonly string[]): SeedArgs {
  const out: SeedArgs = { scale: DEFAULTS.scale, seed: DEFAULTS.seed, reset: false, withRomance: false, username: null, days: DEFAULTS.days, help: false }
  const take = (name: string, index: number): { value: string; used: number } => {
    const raw = argv[index]
    const eq = raw.indexOf('=')
    if (eq >= 0) return { value: raw.slice(eq + 1), used: 1 }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new SeedRefusal(`${name} needs a value`)
    return { value, used: 2 }
  }
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index].split('=')[0]
    if (flag === '--reset') {
      out.reset = true
      index += 1
    } else if (flag === '--with-romance') {
      out.withRomance = true
      index += 1
    } else if (flag === '--help' || flag === '-h') {
      out.help = true
      index += 1
    } else if (flag === '--scale') {
      const { value, used } = take(flag, index)
      const scale = Number(value)
      if (!Number.isInteger(scale) || scale < 50 || scale > 50_000) throw new SeedRefusal('--scale must be a whole number from 50 to 50000')
      out.scale = scale
      index += used
    } else if (flag === '--days') {
      const { value, used } = take(flag, index)
      const days = Number(value)
      if (!Number.isInteger(days) || days < 14 || days > 400) throw new SeedRefusal('--days must be a whole number from 14 to 400')
      out.days = days
      index += used
    } else if (flag === '--seed') {
      const { value, used } = take(flag, index)
      out.seed = value
      index += used
    } else if (flag === '--username') {
      const { value, used } = take(flag, index)
      if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(value)) throw new SeedRefusal('--username must be 2 to 30 characters: lower-case letters, digits, "_" or "-"')
      out.username = value
      index += used
    } else {
      throw new SeedRefusal(`unknown argument ${argv[index]} (see --help)`)
    }
  }
  return out
}
