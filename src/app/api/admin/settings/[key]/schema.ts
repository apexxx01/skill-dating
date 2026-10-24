import { z } from 'zod'

// The request schema of PUT /api/admin/settings/{key}: the new value, which the route checks against the schema of that setting (src/lib/settings.ts).
export const updateSettingSchema = z.object({ value: z.unknown() }).strict()
