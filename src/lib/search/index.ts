import type { PrismaClient } from '@prisma/client'
import { loadViewerScope } from '@/lib/posts/posts'
import { PostgresSearch } from './postgres'
import { isSearchable, tidyQuery } from './query'
import { decodeCursor, encodeCursor, HIT_TYPE, SEARCH_LIMITS, type SearchHit, type SearchProvider, type SearchScope, type SearchType } from './types'

export * from './types'

// The search service (docs/SEARCH.md): works out what the caller may see, asks the provider for a page, and cuts the answer. The route is a thin wrapper on this.

const globalForSearch = globalThis as unknown as { __search?: SearchProvider }

/** The provider in use. PostgreSQL today; a Meilisearch or Typesense provider is chosen here when there is one. */
export async function getSearch(): Promise<SearchProvider> {
  if (!globalForSearch.__search) {
    const { prisma } = await import('@/lib/prisma')
    globalForSearch.__search = new PostgresSearch(prisma)
  }
  return globalForSearch.__search
}

/** Replaces the process-wide provider (tests, or the day another engine takes over). */
export function setSearch(provider: SearchProvider | undefined) {
  globalForSearch.__search = provider
}

/** What the caller may see: who is hidden from them, whom they follow, which projects and crews they belong to. */
export async function searchScopeFor(db: Pick<PrismaClient, 'follow' | 'projectMember' | 'project' | 'teamMember' | 'block' | 'mute'>, viewerId: string, now: Date): Promise<SearchScope> {
  const viewer = await loadViewerScope(db as PrismaClient, viewerId)
  return { viewerId, hiddenUserIds: [...viewer.hidden], followingIds: [...viewer.following], projectIds: [...viewer.projectIds], teamIds: [...viewer.teamIds], now }
}

export interface SearchRequest {
  q: string
  types: SearchType[]
  limit: number
  cursor?: string
}

export interface SearchResponse {
  /** The query as it was searched: tidied. */
  query: string
  types: SearchType[]
  results: SearchHit[]
  nextCursor: string | null
}

export type SearchOutcome = { kind: 'ok'; data: SearchResponse } | { kind: 'invalid-cursor' }

export async function runSearch(db: Pick<PrismaClient, 'follow' | 'projectMember' | 'project' | 'teamMember' | 'block' | 'mute'>, viewerId: string, request: SearchRequest, provider?: SearchProvider, now: Date = new Date()): Promise<SearchOutcome> {
  const tidy = tidyQuery(request.q)
  const empty: SearchOutcome = { kind: 'ok', data: { query: tidy.text, types: request.types, results: [], nextCursor: null } }
  const cursor = request.cursor === undefined ? null : decodeCursor(request.cursor)
  if (request.cursor !== undefined && !cursor) return { kind: 'invalid-cursor' }
  // Too short to search: an empty list, so a palette that asks on every keystroke needs no special case.
  if (!isSearchable(tidy)) return empty

  const limit = Math.min(Math.max(request.limit, 1), SEARCH_LIMITS.maxLimit)
  const [scope, search] = await Promise.all([searchScopeFor(db, viewerId, now), provider ?? getSearch()])
  const page = await search.search({ text: tidy.text, words: tidy.words, types: request.types, limit: limit + 1, after: cursor }, scope)

  const shown = page.hits.slice(0, limit)
  const last = shown[shown.length - 1]
  const hasMore = page.hits.length > limit
  return {
    kind: 'ok',
    data: {
      query: tidy.text,
      types: request.types,
      results: shown.map((ranked) => ranked.hit),
      nextCursor: hasMore && last ? encodeCursor({ score: last.score, type: HIT_TYPE[last.hit.type], id: last.hit.id }) : null,
    },
  }
}
