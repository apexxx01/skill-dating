import { z } from 'zod'
import { MAX_CUSTOM_LABEL, SQUAD_ROLES } from './roles'

// Request shapes shared by the squad routes.

export const squadRoleSchema = z.enum(SQUAD_ROLES)

const skillName = z.string().trim().min(1).max(50)

/** An open slot: a role from the catalogue, a label when it is OTHER, and the skills it needs. */
export const slotInputSchema = z
  .object({
    role: squadRoleSchema,
    customLabel: z.string().trim().min(1).max(MAX_CUSTOM_LABEL).optional(),
    requiredSkills: z.array(skillName).max(10).default([]),
  })
  .strict()
  .refine((slot) => slot.role !== 'OTHER' || Boolean(slot.customLabel), { message: 'An OTHER slot needs a customLabel', path: ['customLabel'] })

export type SlotInput = z.infer<typeof slotInputSchema>

export const slotUpdateSchema = z
  .object({
    role: squadRoleSchema,
    customLabel: z.string().trim().min(1).max(MAX_CUSTOM_LABEL).nullable(),
    requiredSkills: z.array(skillName).max(10),
    position: z.number().int().min(0).max(100),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')
