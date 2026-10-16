import { describe, it, expect } from 'vitest'
import {
  cursorParam,
  decodeKeysetCursor,
  decodeOffsetCursor,
  decodeRankCursor,
  encodeKeysetCursor,
  encodeOffsetCursor,
  encodeRankCursor,
  keysetOrderBy,
  keysetPage,
  keysetWhere,
  offsetCursorAfterPage,
  offsetPage,
  paginate,
  paginateOffset,
  withNextCursor,
  NEXT_CURSOR_HEADER,
} from './pagination'

describe('keyset cursors', () => {
  it('round-trips a date, a number and a string sort value with the id', () => {
    const date = new Date('2026-03-04T05:06:07.890Z')
    expect(decodeKeysetCursor(encodeKeysetCursor(date, 'id1'))).toEqual({ sort: date, id: 'id1' })
    expect(decodeKeysetCursor(encodeKeysetCursor(42.5, 'id2'))).toEqual({ sort: 42.5, id: 'id2' })
    expect(decodeKeysetCursor(encodeKeysetCursor('alpha', 'id3'))).toEqual({ sort: 'alpha', id: 'id3' })
    expect(decodeKeysetCursor(encodeKeysetCursor(-3, 'id4'))).toEqual({ sort: -3, id: 'id4' })
  })

  it('is URL-safe and opaque', () => {
    const cursor = encodeKeysetCursor(new Date(), 'abc')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cursor).not.toContain('abc')
  })

  it('rejects text that is not a cursor, without throwing', () => {
    for (const bad of ['', 'not a cursor', '!!!', 'e30', Buffer.from('{"k":"keyset"}').toString('base64url'), Buffer.from('[]').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      expect(decodeKeysetCursor(bad)).toBeNull()
    }
  })

  it('rejects well-formed JSON with the wrong shape', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 'd', v: 'x' }, id: 'a' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 'n', v: null }, id: 'a' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 'q', v: 1 }, id: 'a' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 's', v: 'x' }, id: '' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 's', v: 'x' }, id: 'a'.repeat(129) }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 's', v: 'x'.repeat(201) }, id: 'a' }))).toBeNull()
  })

  it('is not accepted as an offset cursor, nor the reverse', () => {
    expect(decodeOffsetCursor(encodeKeysetCursor('a', 'b'))).toBeNull()
    expect(decodeKeysetCursor(encodeOffsetCursor(10))).toBeNull()
  })
})

describe('keysetWhere and keysetOrderBy', () => {
  const position = { sort: new Date('2026-01-01T00:00:00Z'), id: 'row9' }

  it('seeks below the last row when descending, with the id breaking ties', () => {
    expect(keysetWhere('createdAt', 'desc', position)).toEqual({
      OR: [{ createdAt: { lt: position.sort } }, { createdAt: position.sort, id: { lt: 'row9' } }],
    })
    expect(keysetOrderBy('createdAt', 'desc')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('seeks above the last row when ascending', () => {
    expect(keysetWhere('name', 'asc', { sort: 'm', id: 'x' })).toEqual({ OR: [{ name: { gt: 'm' } }, { name: 'm', id: { gt: 'x' } }] })
    expect(keysetOrderBy('name', 'asc')).toEqual([{ name: 'asc' }, { id: 'asc' }])
  })

  it('can break ties on a column other than id', () => {
    expect(keysetWhere('createdAt', 'desc', position, 'userId')).toEqual({
      OR: [{ createdAt: { lt: position.sort } }, { createdAt: position.sort, userId: { lt: 'row9' } }],
    })
  })
})

// A tiny in-memory "table" that answers the same where/orderBy the helpers produce,
// to prove that paging through it visits every row exactly once.
type Row = { id: string; at: number }
function seek(rows: Row[], direction: 'asc' | 'desc', after: { sort: number; id: string } | null, take: number): Row[] {
  const sorted = [...rows].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at - b.at))
  if (direction === 'desc') sorted.reverse()
  const filtered = after
    ? sorted.filter((row) => {
        const past = direction === 'desc' ? row.at < after.sort || (row.at === after.sort && row.id < after.id) : row.at > after.sort || (row.at === after.sort && row.id > after.id)
        return past
      })
    : sorted
  return filtered.slice(0, take)
}

describe('keysetPage', () => {
  const table: Row[] = Array.from({ length: 23 }, (_, index) => ({ id: `r${String(index).padStart(2, '0')}`, at: Math.floor(index / 4) }))

  it.each(['asc', 'desc'] as const)('visits every row once, in order, including rows that tie (%s)', (direction) => {
    const seen: string[] = []
    let after: { sort: number; id: string } | null = null
    for (let guard = 0; guard < 20; guard++) {
      const rows = seek(table, direction, after, 6)
      const page = keysetPage(rows, 5, (row) => ({ sort: row.at, id: row.id }))
      seen.push(...page.items.map((row) => row.id))
      if (!page.nextCursor) break
      const decoded = decodeKeysetCursor(page.nextCursor)!
      after = { sort: decoded.sort as number, id: decoded.id }
    }
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(seen).toEqual(seek(table, direction, null, 100).map((row) => row.id))
  })

  it('has no cursor on the last page, on an exact fit, or when empty', () => {
    const row = (n: number) => ({ id: `r${n}`, at: n })
    expect(keysetPage([row(1), row(2)], 5, (r) => ({ sort: r.at, id: r.id })).nextCursor).toBeNull()
    expect(keysetPage([row(1), row(2), row(3), row(4), row(5)], 5, (r) => ({ sort: r.at, id: r.id })).nextCursor).toBeNull()
    expect(keysetPage([], 5, (r: Row) => ({ sort: r.at, id: r.id }))).toEqual({ items: [], nextCursor: null })
  })

  it('does not return the extra row it fetched to look ahead', () => {
    const rows = Array.from({ length: 6 }, (_, n) => ({ id: `r${n}`, at: n }))
    const page = keysetPage(rows, 5, (r) => ({ sort: r.at, id: r.id }))
    expect(page.items).toHaveLength(5)
    expect(decodeKeysetCursor(page.nextCursor!)).toEqual({ sort: 4, id: 'r4' })
  })

  it('does not skip or repeat rows when a new row arrives between pages', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, n) => ({ id: `r${n}`, at: n }))
    const first = keysetPage(seek(rows, 'desc', null, 4), 3, (r) => ({ sort: r.at, id: r.id }))
    rows.push({ id: 'new', at: 100 })
    const decoded = decodeKeysetCursor(first.nextCursor!)!
    const second = keysetPage(seek(rows, 'desc', { sort: decoded.sort as number, id: decoded.id }, 4), 3, (r) => ({ sort: r.at, id: r.id }))
    expect(first.items.map((r) => r.id)).toEqual(['r9', 'r8', 'r7'])
    expect(second.items.map((r) => r.id)).toEqual(['r6', 'r5', 'r4'])
  })
})

describe('offset cursors', () => {
  it('round-trips and rejects other input', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(0))).toBe(0)
    expect(decodeOffsetCursor(encodeOffsetCursor(250))).toBe(250)
    expect(decodeOffsetCursor('garbage')).toBeNull()
    expect(decodeOffsetCursor(Buffer.from('{"k":"offset","o":-1}').toString('base64url'))).toBeNull()
    expect(decodeOffsetCursor(Buffer.from('{"k":"offset","o":1.5}').toString('base64url'))).toBeNull()
    expect(decodeOffsetCursor(Buffer.from('{"k":"offset","o":99999999}').toString('base64url'))).toBeNull()
  })
})

describe('offsetPage', () => {
  const all = Array.from({ length: 12 }, (_, n) => n)

  it('pages through a computed list and ends with no cursor', () => {
    const seen: number[] = []
    let offset = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = offsetPage(all, offset, 5)
      seen.push(...page.items)
      if (!page.nextCursor) break
      offset = decodeOffsetCursor(page.nextCursor)!
    }
    expect(seen).toEqual(all)
  })

  it('has no cursor when the list ends exactly on the page', () => {
    expect(offsetPage(all, 7, 5).nextCursor).toBeNull()
    expect(offsetPage(all, 0, 12).nextCursor).toBeNull()
    expect(offsetPage([], 0, 5)).toEqual({ items: [], nextCursor: null })
  })

  it('gives an empty page past the end', () => {
    expect(offsetPage(all, 50, 5)).toEqual({ items: [], nextCursor: null })
  })
})

describe('offsetCursorAfterPage', () => {
  it('points at the next page, and is null on the last', () => {
    expect(decodeOffsetCursor(offsetCursorAfterPage(1, 20, 45)!)).toBe(20)
    expect(decodeOffsetCursor(offsetCursorAfterPage(2, 20, 45)!)).toBe(40)
    expect(offsetCursorAfterPage(3, 20, 45)).toBeNull()
    expect(offsetCursorAfterPage(1, 20, 20)).toBeNull()
    expect(offsetCursorAfterPage(1, 20, 0)).toBeNull()
  })
})

describe('cursorParam', () => {
  it('is optional and bounded', () => {
    expect(cursorParam.safeParse(undefined).success).toBe(true)
    expect(cursorParam.safeParse('abc').success).toBe(true)
    expect(cursorParam.safeParse('').success).toBe(false)
    expect(cursorParam.safeParse('x'.repeat(401)).success).toBe(false)
  })
})

describe('paginate', () => {
  type Row = { id: string; at: Date }
  const table: Row[] = Array.from({ length: 23 }, (_, index) => ({ id: `r${String(index).padStart(2, '0')}`, at: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 3))) }))

  // Answers the query the helper builds, the way the database would.
  function database() {
    const calls: { where: unknown; skip?: number; take: number }[] = []
    const matches = (where: any, row: Row): boolean => {
      if (!where || Object.keys(where).length === 0) return true
      if (where.AND) return where.AND.every((part: unknown) => matches(part, row))
      if (where.OR) return where.OR.some((part: unknown) => matches(part, row))
      if (where.onlyBefore) return row.at < where.onlyBefore
      return Object.entries(where).every(([key, condition]: [string, any]) => {
        const value = (row as any)[key]
        if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
          if ('lt' in condition) return value < condition.lt
          if ('gt' in condition) return value > condition.gt
        }
        return condition instanceof Date ? value.getTime() === condition.getTime() : value === condition
      })
    }
    return {
      calls,
      find: async ({ where, orderBy, skip = 0, take }: { where: any; orderBy: any; skip?: number; take: number }) => {
        calls.push({ where, skip, take })
        const [primary] = orderBy as [Record<string, string>, Record<string, string>]
        const sign = primary.at === 'desc' ? -1 : 1
        const sorted = table
          .filter((row) => matches(where, row))
          .sort((a, b) => sign * (a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id)))
        return sorted.slice(skip, skip + take)
      },
      count: async (where: any) => table.filter((row) => matches(where, row)).length,
    }
  }

  const run = (db: ReturnType<typeof database>, extra: Partial<Parameters<typeof paginate<Row, any, any>>[0]> = {}) =>
    paginate<Row, any, any>({ cursor: undefined, page: 1, limit: 5, field: 'at', direction: 'desc', where: {}, find: db.find, count: db.count, sortOf: (row) => row.at, ...extra })

  it('answers a page request as before, and adds the cursor to continue with', async () => {
    const db = database()
    const result = await run(db)
    if ('invalidCursor' in result) throw new Error('unexpected')
    expect(result.items).toHaveLength(5)
    expect(result.pagination).toEqual({ page: 1, limit: 5, total: 23, totalPages: 5 })
    expect(result.nextCursor).not.toBeNull()
    expect(db.calls[0]).toMatchObject({ skip: 0, take: 6 })
  })

  it('pages by number to the end, where there is no cursor', async () => {
    const db = database()
    const last = await run(db, { page: 5 })
    if ('invalidCursor' in last) throw new Error('unexpected')
    expect(last.items).toHaveLength(3)
    expect(last.nextCursor).toBeNull()
    expect(last.pagination?.page).toBe(5)
  })

  it('continues from the cursor of a page request with the same rows a page request would give', async () => {
    const db = database()
    const first = await run(db)
    const byPage = await run(db, { page: 2 })
    const byCursor = await run(db, { cursor: (first as { nextCursor: string }).nextCursor })
    if ('invalidCursor' in byPage || 'invalidCursor' in byCursor) throw new Error('unexpected')
    expect(byCursor.items.map((row) => row.id)).toEqual(byPage.items.map((row) => row.id))
  })

  it('visits every row once by cursor, runs no count and gives no page numbers', async () => {
    const db = database()
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const result = await run(db, { cursor })
      if ('invalidCursor' in result) throw new Error('unexpected')
      // The first request has no cursor yet, so it is a page request; every later one is a cursor request.
      if (cursor) expect(result.pagination).toBeUndefined()
      seen.push(...result.items.map((row) => row.id))
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(seen).toEqual([...table].sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id)).map((row) => row.id))
  })

  it('keeps the route filter when it seeks', async () => {
    const db = database()
    const cutoff = new Date(Date.UTC(2026, 0, 5))
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const result = await run(db, { cursor, where: { onlyBefore: cutoff } })
      if ('invalidCursor' in result) throw new Error('unexpected')
      seen.push(...result.items.map((row) => row.id))
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    expect(seen).toHaveLength(table.filter((row) => row.at < cutoff).length)
  })

  it('reports a cursor that is not a keyset cursor', async () => {
    const db = database()
    expect(await run(db, { cursor: 'garbage' })).toEqual({ invalidCursor: true })
    expect(await run(db, { cursor: encodeOffsetCursor(5) })).toEqual({ invalidCursor: true })
    expect(db.calls).toHaveLength(0)
  })

  it('has no cursor on an empty list', async () => {
    const db = database()
    const result = await run(db, { where: { onlyBefore: new Date(0) } })
    expect(result).toEqual({ items: [], nextCursor: null, pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } })
  })
})

describe('paginateOffset', () => {
  const all = Array.from({ length: 23 }, (_, index) => `row${index}`)
  const find = async ({ skip, take }: { where: unknown; skip: number; take: number }) => all.slice(skip, skip + take)
  const count = async () => all.length
  const run = (extra: Partial<Parameters<typeof paginateOffset<string, unknown>>[0]> = {}) =>
    paginateOffset<string, unknown>({ cursor: undefined, page: 1, limit: 5, where: {}, find, count, ...extra })

  it('answers a page request with the page numbers and a cursor to continue', async () => {
    const result = await run()
    expect(result).toMatchObject({ items: all.slice(0, 5), pagination: { page: 1, limit: 5, total: 23, totalPages: 5 } })
    expect(decodeOffsetCursor((result as { nextCursor: string }).nextCursor)).toBe(5)
  })

  it('gives no cursor on the last page', async () => {
    expect(await run({ page: 5 })).toMatchObject({ items: all.slice(20), nextCursor: null })
    expect(await run({ limit: 23 })).toMatchObject({ nextCursor: null })
  })

  it('visits every row once by cursor, without page numbers', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const result = await run({ cursor })
      if ('invalidCursor' in result) throw new Error('unexpected')
      if (cursor) expect(result.pagination).toBeUndefined()
      seen.push(...result.items)
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    expect(seen).toEqual(all)
  })

  it('reports a cursor that is not an offset cursor', async () => {
    expect(await run({ cursor: 'garbage' })).toEqual({ invalidCursor: true })
    expect(await run({ cursor: encodeKeysetCursor('a', 'b') })).toEqual({ invalidCursor: true })
  })
})

describe('withNextCursor', () => {
  it('puts the cursor in a header, and leaves the header off the last page', () => {
    expect(withNextCursor(new Response('[]'), 'abc').headers.get(NEXT_CURSOR_HEADER)).toBe('abc')
    expect(withNextCursor(new Response('[]'), null).headers.get(NEXT_CURSOR_HEADER)).toBeNull()
    expect(NEXT_CURSOR_HEADER).toBe('X-Next-Cursor')
  })
})

describe('rank cursors', () => {
  it('round-trips a rank with and without the member who held it', () => {
    expect(decodeRankCursor(encodeRankCursor({ rank: 20, member: 'user-9' }))).toEqual({ rank: 20, member: 'user-9' })
    expect(decodeRankCursor(encodeRankCursor({ rank: 0 }))).toEqual({ rank: 0 })
    expect(decodeRankCursor(encodeRankCursor({ rank: 5_000_000, member: 'x' }))).toEqual({ rank: 5_000_000, member: 'x' })
  })

  it('is opaque and is not a keyset or offset cursor', () => {
    const cursor = encodeRankCursor({ rank: 20, member: 'user-9' })
    expect(cursor).not.toContain('user-9')
    expect(decodeKeysetCursor(cursor)).toBeNull()
    expect(decodeOffsetCursor(cursor)).toBeNull()
    expect(decodeRankCursor(encodeOffsetCursor(20))).toBeNull()
    expect(decodeRankCursor(encodeKeysetCursor('a', 'b'))).toBeNull()
  })

  it('refuses anything that is not a well-formed rank cursor', () => {
    const forge = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    expect(decodeRankCursor('garbage')).toBeNull()
    expect(decodeRankCursor('')).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: -1 }))).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: 1.5 }))).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: 'five' }))).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: 1e12 }))).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: 3, m: 7 }))).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: 3, m: '' }))).toBeNull()
    expect(decodeRankCursor(forge({ k: 'rank', r: 3, m: 'x'.repeat(129) }))).toBeNull()
    expect(decodeRankCursor(forge({ r: 3 }))).toBeNull()
  })
})
