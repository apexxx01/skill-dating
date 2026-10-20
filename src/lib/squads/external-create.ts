import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { getPageFetcher, PageFetchError, type FetchRefusal } from '@/lib/infra/page-fetch'
import { normalizeExternalUrl, parseHackathonPage, platformOf, sanitizeText, statusByDates, METADATA_LIMITS, type PageMetadata } from './external'
import { slugify } from './teams'
import { tracksSchema } from './tracks'

// Adding an external hackathon from its link (POST /api/hackathons/external, docs/SQUADS.md "External hackathons"): the link is normalised and
// looked up first (one hackathon per page, however it is spelled), then the public page is fetched through the safe fetcher and read for its name,
// dates, image and description; what the caller sends overrides it. The hackathon is created EXTERNAL and unverified: usable for squads at once,
// paying no XP and flagged in every response until an admin verifies it.

type Db = PrismaClient

export const externalHackathonSchema = z
  .object({
    url: z.string().trim().min(8).max(2000),
    name: z.string().trim().min(1).max(METADATA_LIMITS.name).optional(),
    description: z.string().trim().max(METADATA_LIMITS.description).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    mode: z.enum(['ONLINE', 'IN_PERSON', 'HYBRID']).optional(),
    city: z.string().trim().max(METADATA_LIMITS.place).optional(),
    country: z.string().trim().max(METADATA_LIMITS.place).optional(),
    tracks: tracksSchema.optional(),
    minTeamSize: z.number().int().min(1).max(10).optional(),
    maxTeamSize: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .refine((body) => !body.minTeamSize || !body.maxTeamSize || body.minTeamSize <= body.maxTeamSize, { message: 'minTeamSize is above maxTeamSize', path: ['minTeamSize'] })

/** Refusals that are about the link itself (the SSRF rules), as opposed to a page that could not be read this time. */
const REFUSED: readonly FetchRefusal[] = ['invalid-url', 'scheme', 'port', 'credentials', 'private-address', 'redirect-off-host']

export type ExternalOutcome =
  | { ok: true; created: boolean; hackathonId: string }
  | { ok: false; code: 'VALIDATION_FAILED' | 'EXTERNAL_URL_REFUSED' | 'EXTERNAL_PAGE_UNREADABLE' | 'EXTERNAL_DATES_UNKNOWN'; reason?: string }

export async function addExternalHackathon(db: Db, input: { submitterId: string; body: z.infer<typeof externalHackathonSchema>; now?: Date }): Promise<ExternalOutcome> {
  const now = input.now ?? new Date()
  const { body } = input
  const externalUrl = normalizeExternalUrl(body.url)
  if (!externalUrl) return { ok: false, code: 'EXTERNAL_URL_REFUSED' }

  const existing = await db.hackathon.findUnique({ where: { externalUrl }, select: { id: true } })
  if (existing) return { ok: true, created: false, hackathonId: existing.id }

  let page: PageMetadata | null = null
  try {
    // The link as given (the normalised spelling is for finding duplicates; it may not be what the page answers on).
    const fetched = await getPageFetcher().fetchPage(body.url)
    page = parseHackathonPage(fetched.html, fetched.url)
  } catch (error) {
    if (!(error instanceof PageFetchError)) throw error
    if (REFUSED.includes(error.reason)) return { ok: false, code: 'EXTERNAL_URL_REFUSED', reason: error.reason }
    // A page that is down or slow right now: what the caller sent is enough if it names the hackathon and its dates.
    if (!(body.name && body.startDate && body.endDate)) return { ok: false, code: 'EXTERNAL_PAGE_UNREADABLE', reason: error.reason }
  }

  const name = body.name ?? page?.name ?? null
  const startDate = body.startDate ? new Date(body.startDate) : (page?.startDate ?? null)
  const endDate = body.endDate ? new Date(body.endDate) : (page?.endDate ?? null)
  if (!startDate || !endDate) return { ok: false, code: 'EXTERNAL_DATES_UNKNOWN' }
  if (!name) return { ok: false, code: 'VALIDATION_FAILED', reason: 'name' }
  if (endDate.getTime() < startDate.getTime()) return { ok: false, code: 'VALIDATION_FAILED', reason: 'endDate' }

  const description = sanitizeText(body.description, METADATA_LIMITS.description) ?? page?.description ?? `${name}, on ${new URL(externalUrl).hostname}`
  const base = slugify(name).slice(0, 60)
  const slug = (await db.hackathon.findUnique({ where: { slug: base }, select: { id: true } })) ? `${base}-${Date.now().toString(36)}` : base
  const minTeamSize = body.minTeamSize ?? 1
  const maxTeamSize = Math.max(minTeamSize, body.maxTeamSize ?? 5)

  try {
    const hackathon = await db.$transaction(async (tx) => {
      const created = await tx.hackathon.create({
        data: {
          name: sanitizeText(name, METADATA_LIMITS.name) ?? name,
          slug,
          description,
          shortDesc: description.slice(0, 300),
          startDate,
          endDate,
          status: statusByDates(startDate, endDate, now),
          source: 'EXTERNAL',
          externalUrl,
          platform: platformOf(externalUrl),
          websiteUrl: externalUrl,
          mode: body.mode ?? page?.mode ?? null,
          location: body.mode ?? page?.mode ?? null,
          city: sanitizeText(body.city, METADATA_LIMITS.place) ?? page?.city ?? null,
          country: sanitizeText(body.country, METADATA_LIMITS.place) ?? page?.country ?? null,
          banner: page?.image ?? null,
          tracks: (body.tracks ?? []).map((track) => ({ name: track.name, description: track.description ?? null })),
          minTeamSize,
          maxTeamSize,
          submittedById: input.submitterId,
          verifiedAt: null,
        },
        select: { id: true },
      })
      // Its own conversation, like a native hackathon's: registrants join it.
      await tx.conversation.create({ data: { type: 'HACKATHON', hackathonId: created.id, members: { create: { userId: input.submitterId, role: 'MEMBER' } } } })
      return created
    })
    return { ok: true, created: true, hackathonId: hackathon.id }
  } catch (error) {
    // Two people adding the same link at the same moment: the second finds the first's.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await db.hackathon.findUnique({ where: { externalUrl }, select: { id: true } })
      if (raced) return { ok: true, created: false, hackathonId: raced.id }
    }
    throw error
  }
}

/** The flag every hackathon response carries: an external hackathon no admin has verified yet. */
export const isUnverified = (hackathon: { source: string; verifiedAt: Date | null }) => hackathon.source === 'EXTERNAL' && hackathon.verifiedAt === null
