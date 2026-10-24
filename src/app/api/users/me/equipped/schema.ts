import { z } from 'zod'
import { MAX_BADGES_SHOWN } from '@/lib/cosmetic-definitions'

// The request schemas of users/me/equipped, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const slug = z.string().trim().min(1).max(64).nullable()

// The badges worn, in order: a list replaces the whole slot ([] takes them all off).
export const badges = z
  .array(z.string().trim().min(1).max(64))
  .max(MAX_BADGES_SHOWN, `At most ${MAX_BADGES_SHOWN} badges can be worn`)
  .refine((list) => new Set(list).size === list.length, 'Each badge can be worn once')

export const bodySchema = z
  .object({ title: slug, frame: slug, banner: slug, badges })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one of title, frame, banner, badges')
