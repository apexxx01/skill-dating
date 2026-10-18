import { describe, it, expect } from 'vitest'
import { ROMANCE_MODE_LABEL } from '@/lib/romance/config'
import { isNotificationKind, KIND_SPECS, NOTIFICATION_KINDS } from './notification-kinds'

describe('notification kinds', () => {
  it('has a type and a label for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(KIND_SPECS[kind].label.length, kind).toBeGreaterThan(5)
      expect(KIND_SPECS[kind].type, kind).toMatch(/^[A-Z_]+$/)
    }
    expect(Object.keys(KIND_SPECS).sort()).toEqual([...NOTIFICATION_KINDS].sort())
  })

  it('has a switch for the weekly romance pick, named from the one constant', () => {
    expect(KIND_SPECS.ROMANCE_DROP.label).toContain(ROMANCE_MODE_LABEL)
  })

  it('keeps a spark and the daily count of sparks as two switches under one type', () => {
    expect(KIND_SPECS.SPARK.type).toBe('SPARK')
    expect(KIND_SPECS.SPARK_DIGEST.type).toBe('SPARK')
  })

  it('recognises only its own kinds', () => {
    expect(isNotificationKind('SPARK_DIGEST')).toBe(true)
    expect(isNotificationKind('props')).toBe(false)
    expect(isNotificationKind('MATCH')).toBe(false)
    expect(isNotificationKind(undefined)).toBe(false)
  })
})
