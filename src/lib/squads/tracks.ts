import type { Prisma } from '@prisma/client'
import { z } from 'zod'

// A hackathon's tracks: what squads can go for ("Best use of AI", "DeFi"). Stored as JSON on the hackathon; a squad keeps the names it chose
// (Team.targetTracks), and the squad builder's role template adapts to them (src/lib/squads/roles.ts templateFor).

export interface Track {
  name: string
  description: string | null
}

export const MAX_TRACKS = 20

export const trackSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).nullable().optional() }).strict()
export const tracksSchema = z
  .array(trackSchema)
  .max(MAX_TRACKS)
  .refine((tracks) => new Set(tracks.map((track) => track.name.toLowerCase())).size === tracks.length, 'Track names must be unique')

/** The tracks stored on a hackathon, read defensively: anything malformed is left out. */
export function tracksOf(value: Prisma.JsonValue | null | undefined): Track[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = trackSchema.safeParse(entry)
    return parsed.success ? [{ name: parsed.data.name, description: parsed.data.description ?? null }] : []
  })
}

/** The names among `wanted` that are not tracks of the hackathon (compared without case). */
export function unknownTracks(tracks: readonly Track[], wanted: readonly string[]): string[] {
  const names = new Set(tracks.map((track) => track.name.toLowerCase()))
  return wanted.filter((name) => !names.has(name.trim().toLowerCase()))
}

/** The hackathon's own spelling of the wanted names, each once. */
export function canonicalTracks(tracks: readonly Track[], wanted: readonly string[]): string[] {
  const byName = new Map(tracks.map((track) => [track.name.toLowerCase(), track.name]))
  return [...new Set(wanted.map((name) => byName.get(name.trim().toLowerCase())).filter((name): name is string => Boolean(name)))]
}
