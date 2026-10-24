import { z } from 'zod'

// The request schemas of projects/[id], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  shortDesc: z.string().max(300).optional(),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).optional(),
  githubUrl: z.string().max(2048).url().optional().or(z.literal('')),
  demoUrl: z.string().max(2048).url().optional().or(z.literal('')),
  websiteUrl: z.string().max(2048).url().optional().or(z.literal('')),
  techStack: z.array(z.string().max(50)).max(20).optional(),
  lookingFor: z.array(z.string().max(50)).max(20).optional(),
  maxTeamSize: z.number().min(1).max(10).optional(),
  isPublic: z.boolean().optional(),
  thumbnail: z.string().max(2048).url().optional().or(z.literal('')),
})
