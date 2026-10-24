import { z } from 'zod'
import { tracksSchema } from '@/lib/squads/tracks'

// The request schemas of hackathons/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const registerSchema = z.object({
  skills: z.array(z.string().max(50)).max(20).default([]),
  lookingFor: z.array(z.string().max(50)).max(20).default([]),
})

export const updateHackathonSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  shortDesc: z.string().max(500).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  registrationDeadline: z.string().datetime().optional(),
  submissionDeadline: z.string().datetime().nullable().optional(),
  tracks: tracksSchema.optional(),
  mode: z.enum(['ONLINE', 'IN_PERSON', 'HYBRID']).optional(),
  city: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  status: z.enum(['UPCOMING', 'ACTIVE', 'ENDED', 'CANCELLED']).optional(),
  prizePool: z.string().max(200).optional(),
  rules: z.string().max(10000).optional(),
  technologies: z.array(z.string().max(50)).max(20).optional(),
  maxTeamSize: z.number().min(1).max(10).optional(),
  minTeamSize: z.number().min(1).max(10).optional(),
  location: z.string().max(200).optional(),
  isPublic: z.boolean().optional(),
  thumbnail: z.string().max(2048).url().optional().or(z.literal('')),
  banner: z.string().max(2048).url().optional().or(z.literal('')),
})
