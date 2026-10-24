import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROMANCE_LAUNCH_THRESHOLD, ROMANCE_LAUNCH_THRESHOLD_KEY, SETTINGS, isSettingKey, readSetting, romanceLaunchThreshold, romanceLaunchThresholdSchema } from './settings'

const reader = (rows: { value: unknown }[] | Error) => ({ $queryRaw: vi.fn(async () => { if (rows instanceof Error) throw rows; return rows }) }) as never

describe('the romance launch threshold', () => {
  it('defaults to 250 interested adults and at least 30 percent for each side of the pairing', () => {
    expect(DEFAULT_ROMANCE_LAUNCH_THRESHOLD).toEqual({ minInterestedAdults: 250, minPairingSharePercent: 30 })
    expect(SETTINGS[ROMANCE_LAUNCH_THRESHOLD_KEY].default).toEqual(DEFAULT_ROMANCE_LAUNCH_THRESHOLD)
  })

  it('accepts sensible values and refuses the rest', () => {
    expect(romanceLaunchThresholdSchema.safeParse({ minInterestedAdults: 400, minPairingSharePercent: 40 }).success).toBe(true)
    for (const bad of [{ minInterestedAdults: 0, minPairingSharePercent: 30 }, { minInterestedAdults: 250.5, minPairingSharePercent: 30 }, { minInterestedAdults: 250, minPairingSharePercent: 51 }, { minInterestedAdults: 250, minPairingSharePercent: -1 }, { minInterestedAdults: 250 }, { minInterestedAdults: 250, minPairingSharePercent: 30, extra: 1 }, 'x', null]) {
      expect(romanceLaunchThresholdSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('reads what an administrator set, and the default when there is no row, a bad row or the store fails', async () => {
    expect(await romanceLaunchThreshold(reader([{ value: { minInterestedAdults: 400, minPairingSharePercent: 35 } }]))).toEqual({ minInterestedAdults: 400, minPairingSharePercent: 35 })
    expect(await romanceLaunchThreshold(reader([]))).toEqual(DEFAULT_ROMANCE_LAUNCH_THRESHOLD)
    expect(await romanceLaunchThreshold(reader([{ value: { minInterestedAdults: 'many' } }]))).toEqual(DEFAULT_ROMANCE_LAUNCH_THRESHOLD)
    expect(await romanceLaunchThreshold(reader(new Error('down')))).toEqual(DEFAULT_ROMANCE_LAUNCH_THRESHOLD)
  })

  it('knows its keys, and refuses to read one it does not know', async () => {
    expect(isSettingKey(ROMANCE_LAUNCH_THRESHOLD_KEY)).toBe(true)
    expect(isSettingKey('toString')).toBe(false)
    expect(isSettingKey('nope')).toBe(false)
    await expect(readSetting(reader([]), 'nope')).rejects.toThrow(/unknown setting/)
  })
})
