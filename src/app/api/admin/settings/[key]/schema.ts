import { z } from 'zod'
import { romanceLaunchThresholdSchema } from '@/lib/settings'

// The request schema of PUT /api/admin/settings/{key}: the new value. Bounded: it is the schema of the one setting there is today (src/lib/settings.ts); a second setting turns `value` into a union of the schemas; the route also
// checks the value against the schema of the key it was sent to.
export const updateSettingSchema = z.object({ value: romanceLaunchThresholdSchema }).strict()
