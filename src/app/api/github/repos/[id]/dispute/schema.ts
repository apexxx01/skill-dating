import { z } from 'zod'

// The request schema of a claim dispute, in a file of its own: a Next.js route may export nothing but its handlers, and the OpenAPI spec reads it.
export const disputeSchema = z
  .object({
    // What is wrong with the claim, for the moderator. Shown to staff only.
    description: z.string().trim().min(10).max(2000),
  })
  .strict()
