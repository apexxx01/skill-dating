import { z } from 'zod'
import { isValidTimeZone } from '@/lib/time'
import { cursorParam } from '@/lib/api/pagination'
import { parseBirthDate } from '@/lib/age'

// The request schemas of users, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  headline: z.string().max(200).optional(),
  location: z.string().max(100).optional(),
  // An IANA name such as "Asia/Kolkata": it decides where this person's day starts (caps, streaks).
  timezone: z.string().max(50).refine(isValidTimeZone, 'must be an IANA time zone such as "Europe/Paris"').optional(),
  availability: z.string().max(200).optional(),
  builderRole: z.string().max(100).optional(),
  website: z.string().max(2048).url().optional().or(z.literal('')),
  githubUsername: z.string().max(100).optional(),
  twitterUsername: z.string().max(100).optional(),
  linkedinUrl: z.string().max(2048).url().optional().or(z.literal('')),
  // PRIVATE, and required to finish onboarding (docs/SAFETY.md). Set once and then locked; under 16 is refused; nobody but the owner ever reads it back.
  birthDate: z.string().max(32).refine((value) => parseBirthDate(value) !== null, 'A real date in the past such as 1995-06-15').optional(),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  skills: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  cursor: cursorParam,
})
