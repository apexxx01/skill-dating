import { z } from 'zod'
import { cursorParam } from '@/lib/api/pagination'

// The request schemas of projects, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  shortDesc: z.string().max(300).optional(),
  githubUrl: z.string().max(2048).url().optional().or(z.literal('')),
  demoUrl: z.string().max(2048).url().optional().or(z.literal('')),
  websiteUrl: z.string().max(2048).url().optional().or(z.literal('')),
  techStack: z.array(z.string().max(50)).max(20).default([]),
  lookingFor: z.array(z.string().max(50)).max(20).default([]),
  maxTeamSize: z.number().min(1).max(10).default(5),
  hackathonId: z.string().max(64).optional(),
  isPublic: z.boolean().default(true),
})

export const updateProjectSchema = createProjectSchema.partial()

export const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).optional(),
  search: z.string().max(200).optional(),
  techStack: z.string().max(200).optional(),
  ownerId: z.string().max(64).optional(),
  cursor: cursorParam,
})
