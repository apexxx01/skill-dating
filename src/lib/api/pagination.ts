import { z } from 'zod'

// Cursor pagination for list endpoints.
//
// A client sends `cursor` (the `nextCursor` of the previous page) and `limit`;
// the response carries `nextCursor`, null on the last page. A cursor is opaque:
// clients must not build or read one. Without `cursor`, list endpoints keep
// answering `page` / `limit` requests as before, with `pagination` and now also
// `nextCursor`, so a client can start with pages and continue with cursors.
//
// Two kinds sit behind the same string:
//  - keyset cursors for lists ordered by stored columns. They remember the sort
//    value and id of the last row and seek past it, so a page costs the same at
//    row 5 or row 5 million, and rows added or removed while someone pages do not
//    shift the pages (offset paging skips or repeats rows then);
//  - offset cursors for lists whose order is computed (compatibility scores,
//    aggregates), where no column can be seeked on. They are still opaque, so the
//    endpoint can move to keyset later without a client change.

/** The query parameter, for a route's own Zod schema. */
export const cursorParam = z.string().min(1).max(400).optional()

export type SortValue = string | number | Date
export type Direction = 'asc' | 'desc'

type Encoded = { k: 'keyset'; s: { t: 'd' | 'n' | 's'; v: string | number }; id: string } | { k: 'offset'; o: number }

function pack(value: Encoded): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function unpack(raw: string): Encoded | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Encoded
    if (value && value.k === 'offset' && Number.isInteger(value.o) && value.o >= 0 && value.o <= 1_000_000) return value
    if (
      value &&
      value.k === 'keyset' &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      value.id.length <= 128 &&
      value.s &&
      ((value.s.t === 'd' && Number.isFinite(value.s.v)) ||
        (value.s.t === 'n' && Number.isFinite(value.s.v)) ||
        (value.s.t === 's' && typeof value.s.v === 'string' && value.s.v.length <= 200))
    ) {
      return value
    }
    return null
  } catch {
    return null
  }
}

// --- Keyset ------------------------------------------------------------------

export interface KeysetPosition {
  sort: SortValue
  id: string
}

export function encodeKeysetCursor(sort: SortValue, id: string): string {
  if (sort instanceof Date) return pack({ k: 'keyset', s: { t: 'd', v: sort.getTime() }, id })
  if (typeof sort === 'number') return pack({ k: 'keyset', s: { t: 'n', v: sort }, id })
  return pack({ k: 'keyset', s: { t: 's', v: sort }, id })
}

/** The position a keyset cursor stands for, or null when it is not a valid keyset cursor. */
export function decodeKeysetCursor(raw: string): KeysetPosition | null {
  const value = unpack(raw)
  if (!value || value.k !== 'keyset') return null
  return { sort: value.s.t === 'd' ? new Date(value.s.v as number) : value.s.v, id: value.id }
}

/**
 * The `where` clause that continues after `position`, for an `orderBy` of
 * `[{ [field]: direction }, { id: direction }]` (see keysetOrderBy). Ties on the
 * sort value are broken by id, so no row is skipped or repeated.
 */
export function keysetWhere(field: string, direction: Direction, position: KeysetPosition, idField = 'id') {
  const op = direction === 'desc' ? 'lt' : 'gt'
  return {
    OR: [{ [field]: { [op]: position.sort } }, { [field]: position.sort, [idField]: { [op]: position.id } }],
  }
}

export function keysetOrderBy(field: string, direction: Direction, idField = 'id') {
  return [{ [field]: direction }, { [idField]: direction }]
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Cuts the extra row off. Fetch `limit + 1` rows; when the extra one is there
 * another page exists, and the cursor points just after the last row returned.
 */
export function keysetPage<T>(rows: T[], limit: number, position: (row: T) => KeysetPosition): Page<T> {
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  if (rows.length <= limit || !last) return { items, nextCursor: null }
  const { sort, id } = position(last)
  return { items, nextCursor: encodeKeysetCursor(sort, id) }
}

// --- Offset ------------------------------------------------------------------

export function encodeOffsetCursor(offset: number): string {
  return pack({ k: 'offset', o: offset })
}

/** The offset an offset cursor stands for, or null when it is not a valid offset cursor. */
export function decodeOffsetCursor(raw: string): number | null {
  const value = unpack(raw)
  return value && value.k === 'offset' ? value.o : null
}

/** Cuts a computed list to one page starting at `offset`. */
export function offsetPage<T>(all: T[], offset: number, limit: number): Page<T> {
  const items = all.slice(offset, offset + limit)
  const next = offset + limit
  return { items, nextCursor: next < all.length ? encodeOffsetCursor(next) : null }
}

/** For a page-numbered request to an offset-cursor list: the cursor that continues after `page`. */
export function offsetCursorAfterPage(page: number, limit: number, total: number): string | null {
  return page * limit < total ? encodeOffsetCursor(page * limit) : null
}
