import { z } from 'zod'
import { Prisma, type PrismaClient } from '@prisma/client'
import { log } from '@/lib/log'

// Values an administrator can change without a deploy: GET /api/admin/settings, PUT /api/admin/settings/{key}, audited. Each known key has a schema and a default; a key
// with no row (or a row that no longer parses) has its default, so a fresh environment works and a bad edit cannot break what reads it.

/**
 * When a city is ready for the romance mode to be opened there (docs/LAUNCH_CHECKLIST.md, "Turning on the romance mode"): at least `minInterestedAdults` adults asked to be told (the
 * admin metrics count them by city), and, of that pool, each side of the interested-in pairing is at least `minPairingSharePercent` percent. The interest list holds only a
 * country and a city, never a gender or a preference, so the first number is measured by the metrics (`romance_interest`, whose city rows carry `meetsInterestThreshold`) and
 * the second has to be evidenced another way (the checklist says how); the product does not collect it.
 */
export const ROMANCE_LAUNCH_THRESHOLD_KEY = 'romance.launch-threshold'

export const romanceLaunchThresholdSchema = z
  .object({
    minInterestedAdults: z.number().int().min(1).max(1_000_000),
    // Two sides that must each reach it cannot ask for more than half the pool.
    minPairingSharePercent: z.number().int().min(0).max(50),
  })
  .strict()

export type RomanceLaunchThreshold = z.infer<typeof romanceLaunchThresholdSchema>

export const DEFAULT_ROMANCE_LAUNCH_THRESHOLD: RomanceLaunchThreshold = { minInterestedAdults: 250, minPairingSharePercent: 30 }

interface SettingDefinition {
  description: string
  schema: z.ZodType<unknown>
  default: unknown
}

export const SETTINGS: Record<string, SettingDefinition> = {
  [ROMANCE_LAUNCH_THRESHOLD_KEY]: {
    description: 'When a city is ready for the romance mode: the fewest interested adults, and the least share (percent) of that pool each side of the interested-in pairing must be.',
    schema: romanceLaunchThresholdSchema,
    default: DEFAULT_ROMANCE_LAUNCH_THRESHOLD,
  },
}

export const isSettingKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(SETTINGS, key)

type Reader = Pick<PrismaClient, '$queryRaw'>

/** The value of a known setting: what an administrator set, else the default (also when the stored value does not parse any more). */
export async function readSetting(db: Reader, key: string): Promise<unknown> {
  const definition = SETTINGS[key]
  if (!definition) throw new Error(`unknown setting ${key}`)
  try {
    const rows = await db.$queryRaw<{ value: unknown }[]>(Prisma.sql`SELECT "value" FROM "PlatformSetting" WHERE "key" = ${key}`)
    if (rows.length === 0) return definition.default
    const parsed = definition.schema.safeParse(rows[0].value)
    if (parsed.success) return parsed.data
    log.warn('a stored setting does not parse; using its default', { key })
  } catch (error) {
    log.warn('could not read a setting; using its default', { key, error })
  }
  return definition.default
}

export async function romanceLaunchThreshold(db: Reader): Promise<RomanceLaunchThreshold> {
  return (await readSetting(db, ROMANCE_LAUNCH_THRESHOLD_KEY)) as RomanceLaunchThreshold
}

export interface SettingView {
  key: string
  description: string
  value: unknown
  default: unknown
  isDefault: boolean
  updatedById: string | null
  updatedAt: string | null
}

type Store = Pick<PrismaClient, 'platformSetting' | '$queryRaw'>

export async function settingView(db: Store, key: string): Promise<SettingView> {
  const definition = SETTINGS[key]
  const row = await db.platformSetting.findUnique({ where: { key } })
  const value = await readSetting(db, key)
  return {
    key,
    description: definition.description,
    value,
    default: definition.default,
    isDefault: !row,
    updatedById: row?.updatedById ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  }
}

export async function listSettings(db: Store): Promise<SettingView[]> {
  return Promise.all(Object.keys(SETTINGS).sort().map((key) => settingView(db, key)))
}
