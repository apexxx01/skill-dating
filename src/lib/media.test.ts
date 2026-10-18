import { describe, it, expect } from 'vitest'
import { checkDeclaration, mediaDeclarationSchema, objectKey, objectMatches, type MediaDeclaration } from './media'

const sha = 'a'.repeat(64)
const image = (over: Partial<MediaDeclaration> = {}): MediaDeclaration => ({ purpose: 'POST_MEDIA', contentType: 'image/png', bytes: 200_000, width: 1280, height: 720, sha256: sha, ...over })
const problems = (declaration: MediaDeclaration) => checkDeclaration(declaration).problems.map((p) => p.problem)

describe('checkDeclaration', () => {
  it('accepts an ordinary image, gif and video for a post', () => {
    expect(checkDeclaration(image())).toMatchObject({ ok: true, type: 'IMAGE', extension: 'png' })
    expect(checkDeclaration(image({ contentType: 'image/gif', bytes: 5_000_000 }))).toMatchObject({ ok: true, type: 'GIF' })
    expect(checkDeclaration(image({ contentType: 'video/mp4', bytes: 40_000_000, durationMs: 30_000 }))).toMatchObject({ ok: true, type: 'VIDEO', extension: 'mp4' })
  })

  it('refuses a type that is not on the list, however it is capitalised', () => {
    expect(problems(image({ contentType: 'image/svg+xml' }))).toEqual(['TYPE_NOT_ALLOWED'])
    expect(problems(image({ contentType: 'application/pdf' }))).toEqual(['TYPE_NOT_ALLOWED'])
    expect(problems(image({ contentType: 'text/html' }))).toEqual(['TYPE_NOT_ALLOWED'])
    expect(checkDeclaration(image({ contentType: 'IMAGE/PNG' })).ok).toBe(true)
  })

  it('limits the size of each kind', () => {
    expect(problems(image({ bytes: 10 * 1024 * 1024 }))).toEqual([])
    expect(problems(image({ bytes: 10 * 1024 * 1024 + 1 }))).toEqual(['TOO_LARGE'])
    expect(problems(image({ contentType: 'image/gif', bytes: 15 * 1024 * 1024 + 1 }))).toEqual(['TOO_LARGE'])
    expect(problems(image({ contentType: 'video/webm', bytes: 100 * 1024 * 1024 + 1, durationMs: 1000 }))).toEqual(['TOO_LARGE'])
  })

  it('limits the dimensions', () => {
    expect(problems(image({ width: 8000, height: 8000 }))).toEqual([])
    expect(problems(image({ width: 8001 }))).toEqual(['DIMENSIONS_OUT_OF_RANGE'])
    expect(problems(image({ height: 15 }))).toEqual(['DIMENSIONS_OUT_OF_RANGE'])
  })

  it('needs a duration for a video, within two minutes, and none for anything else', () => {
    const video = (over: Partial<MediaDeclaration>) => image({ contentType: 'video/mp4', durationMs: 10_000, ...over })
    expect(problems(video({ durationMs: undefined }))).toEqual(['DURATION_REQUIRED'])
    expect(problems(video({ durationMs: 120_000 }))).toEqual([])
    expect(problems(video({ durationMs: 120_001 }))).toEqual(['DURATION_TOO_LONG'])
    expect(problems(image({ durationMs: 5000 }))).toEqual(['DURATION_NOT_ALLOWED'])
  })

  it('holds a romance photo to a stricter standard: a still image, big enough, at most 8 MB', () => {
    const photo = (over: Partial<MediaDeclaration>) => image({ purpose: 'ROMANCE_PHOTO', contentType: 'image/jpeg', width: 1200, height: 1600, ...over })
    expect(checkDeclaration(photo({})).ok).toBe(true)
    expect(problems(photo({ contentType: 'image/gif' }))).toEqual(['PURPOSE_TYPE_MISMATCH'])
    expect(problems(photo({ contentType: 'video/mp4', durationMs: 5000 }))).toEqual(['PURPOSE_TYPE_MISMATCH'])
    expect(problems(photo({ bytes: 8 * 1024 * 1024 + 1 }))).toEqual(['TOO_LARGE'])
    expect(problems(photo({ width: 399 }))).toEqual(['TOO_SMALL'])
    expect(problems(photo({ width: 400, height: 400 }))).toEqual([])
  })
})

describe('schema, keys and objects', () => {
  it('needs a real hash and a known purpose, and nothing else', () => {
    expect(mediaDeclarationSchema.safeParse(image()).success).toBe(true)
    expect(mediaDeclarationSchema.safeParse(image({ sha256: 'xyz' })).success).toBe(false)
    expect(mediaDeclarationSchema.safeParse(image({ sha256: 'A'.repeat(64) })).success).toBe(false)
    expect(mediaDeclarationSchema.safeParse({ ...image(), purpose: 'AVATAR' }).success).toBe(false)
    expect(mediaDeclarationSchema.safeParse({ ...image(), extra: 1 }).success).toBe(false)
    expect(mediaDeclarationSchema.safeParse(image({ bytes: -1 })).success).toBe(false)
    expect(mediaDeclarationSchema.safeParse(image({ bytes: 1.5 })).success).toBe(false)
  })

  it('addresses an object by owner and content, in a folder per purpose', () => {
    expect(objectKey('POST_MEDIA', 'u1', sha, 'png')).toBe(`posts/u1/${sha}.png`)
    expect(objectKey('ROMANCE_PHOTO', 'u1', sha, 'jpg')).toBe(`romance/u1/${sha}.jpg`)
  })

  it('checks the real object against the declaration', () => {
    expect(objectMatches({ bytes: 10, contentType: 'image/png' }, { size: 10, contentType: 'image/png' })).toBe(true)
    expect(objectMatches({ bytes: 10, contentType: 'image/png' }, { size: 10, contentType: 'IMAGE/PNG; charset=binary' })).toBe(true)
    expect(objectMatches({ bytes: 10, contentType: 'image/png' }, { size: 10, contentType: null })).toBe(true)
    expect(objectMatches({ bytes: 10, contentType: 'image/png' }, { size: 11, contentType: 'image/png' })).toBe(false)
    expect(objectMatches({ bytes: 10, contentType: 'image/png' }, { size: 10, contentType: 'text/html' })).toBe(false)
  })
})
