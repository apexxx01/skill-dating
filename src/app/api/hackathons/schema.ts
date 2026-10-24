import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'
import { tracksSchema } from '@/lib/squads/tracks'

// The request schemas of hackathons, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const createHackathonSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  shortDesc: z.string().max(500).optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  registrationDeadline: z.string().datetime().optional(),
  submissionDeadline: z.string().datetime().optional(),
  tracks: tracksSchema.default([]),
  mode: z.enum(['ONLINE', 'IN_PERSON', 'HYBRID']).optional(),
  city: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  organizer: z.string().max(200).optional(),
  websiteUrl: z.string().max(2048).url().optional().or(z.literal('')),
  prizePool: z.string().max(200).optional(),
  rules: z.string().max(10000).optional(),
  technologies: z.array(z.string().max(50)).max(20).default([]),
  maxTeamSize: z.number().min(1).max(10).default(5),
  minTeamSize: z.number().min(1).max(10).default(1),
  location: z.string().max(200).optional(),
  isPublic: z.boolean().default(true),
  thumbnail: z.string().max(2048).url().optional().or(z.literal('')),
  banner: z.string().max(2048).url().optional().or(z.literal('')),
})

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['UPCOMING', 'ACTIVE', 'ENDED', 'CANCELLED']).optional(),
  search: z.string().max(200).optional(),
  cursor: cursorParam,
})
