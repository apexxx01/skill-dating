import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { NextResponse, type NextRequest } from 'next/server'
import { errorResponse } from '@/lib/api/errors'
import { enforceRateLimit } from '@/lib/rate-limiter'
import { log } from '@/lib/log'
import { cardElement, CARD_SIZE, LAYOUT_VERSION } from './layout'
import type { CardModel } from './models'

// Drawing a card and answering the request (docs/FRONTEND_CONTRACT.md, "Share cards"). The fonts are Inter, in the repository (assets/fonts, SIL Open Font License), read once
// and kept: nothing is fetched from anywhere at render time.

/** A day in browsers and shared caches, and a week of serving the old picture while a new one is made. */
export const CARD_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800'
/** A card that is not there (or is private): short, so making something public or private is felt within a minute, not a day. */
const MISSING_CACHE_CONTROL = 'public, max-age=60'

const FONT_FILES = [
  { file: 'inter-latin-400-normal.woff', weight: 400 },
  { file: 'inter-latin-700-normal.woff', weight: 700 },
  { file: 'inter-latin-ext-400-normal.woff', weight: 400 },
  { file: 'inter-latin-ext-700-normal.woff', weight: 700 },
] as const

type Font = { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' }
let fonts: Promise<Font[]> | undefined

async function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(async ({ file, weight }) => {
      const bytes = await fs.readFile(path.join(process.cwd(), 'assets', 'fonts', file))
      return { name: 'Inter', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, weight, style: 'normal' as const }
    })
  ).catch((error) => {
    fonts = undefined
    throw error
  })
  return fonts
}

/** The ETag of a card: a hash of exactly what is drawn and of the drawing's version, so it changes when (and only when) the picture would. */
export function etagOf(card: CardModel): string {
  return `"og-${createHash('sha256').update(`${LAYOUT_VERSION}:${JSON.stringify(card)}`).digest('hex').slice(0, 24)}"`
}

/** Whether the request's If-None-Match names this tag (a list, with * and weak validators allowed). */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((candidate) => {
    const value = candidate.trim().replace(/^W\//, '')
    return value === '*' || value === etag
  })
}

export async function drawCard(card: CardModel, etag: string): Promise<Response> {
  return new ImageResponse(cardElement(card), {
    ...CARD_SIZE,
    fonts: await loadFonts(),
    headers: { 'Cache-Control': CARD_CACHE_CONTROL, ETag: etag, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' },
  })
}

/**
 * The whole request for a card route: the per-address rate limit (drawing is the expensive part of this platform's API), the lookup, the ETag (a request that already has the
 * current picture gets 304 and nothing is drawn), and the picture. `load` returns null for a card that may not be shown, and the answer is the same 404 whether it never
 * existed or is private, so a card cannot be used to find out which.
 */
export async function cardRoute(request: NextRequest, load: () => Promise<CardModel | null>): Promise<Response> {
  const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: 'og:cards' })
  if (limited) return limited
  try {
    const card = await load()
    if (!card) return errorResponse('CARD_NOT_FOUND', { headers: { 'Cache-Control': MISSING_CACHE_CONTROL } })
    const etag = etagOf(card)
    if (matchesEtag(request.headers.get('if-none-match'), etag)) return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CARD_CACHE_CONTROL } })
    return await drawCard(card, etag)
  } catch (error) {
    log.error('could not draw a share card', { error })
    return errorResponse('INTERNAL_ERROR')
  }
}
