import { z } from 'zod'

// The request schemas of builds/me, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

export const buildSchema = z.object({
  title: z.string().min(1).max(150),
  description: z.string().max(5000).optional(),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).default('BUILDING'),
  progress: z.number().min(0).max(100).default(0),
  techStack: z.array(z.string().max(50)).max(20).default([]),
  teamSize: z.number().min(1).max(20).default(1),
  maxTeamSize: z.number().min(1).max(20).default(5),
  rolesNeeded: z.array(z.string().max(50)).max(20).default([]),
  hackathonId: z.string().max(64).optional(),
  githubUrl: z.string().max(2048).url().optional().or(z.literal('')),
  demoUrl: z.string().max(2048).url().optional().or(z.literal('')),
  isPublic: z.boolean().default(true),
})
