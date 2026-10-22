import { describe, it, expect } from 'vitest'
import { openToken, readOpenToken, readUnsubscribeToken, signToken, unsubscribeToken, verifyToken } from './tokens'

const secret = 'a-test-secret-that-is-at-least-thirty-two-characters'

describe('signed links', () => {
  it('round-trips an unsubscribe scope', () => {
    const token = unsubscribeToken({ userId: 'u1', kind: 'COMMENT' }, secret)
    expect(readUnsubscribeToken(token, secret)).toEqual({ userId: 'u1', kind: 'COMMENT' })
    expect(readUnsubscribeToken(unsubscribeToken({ userId: 'u1', kind: 'ALL' }, secret), secret)).toEqual({ userId: 'u1', kind: 'ALL' })
    expect(readUnsubscribeToken(unsubscribeToken({ userId: 'u1', kind: 'NEUTRAL' }, secret), secret)).toEqual({ userId: 'u1', kind: 'NEUTRAL' })
  })

  it('round-trips a delivery and where it goes', () => {
    expect(readOpenToken(openToken('del_1', '/drops', secret), secret)).toEqual({ deliveryId: 'del_1', path: '/drops' })
  })

  it('never sends anyone outside the app, even with a genuine signature', () => {
    for (const path of ['https://evil.example.com', '//evil.example.com', 'drops', '/\\evil.example.com']) expect(readOpenToken(openToken('del_1', path, secret), secret), path).toBeNull()
  })

  it('refuses a token signed with another secret or changed after it was signed', () => {
    const token = unsubscribeToken({ userId: 'u1', kind: 'COMMENT' }, secret)
    expect(readUnsubscribeToken(token, 'another-secret-that-is-at-least-thirty-two-chars')).toBeNull()
    const [body, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ u: 'someone-else', k: 'COMMENT' })).toString('base64url')
    expect(readUnsubscribeToken(`${forged}.${signature}`, secret)).toBeNull()
    expect(readUnsubscribeToken(`${body}.${signature.slice(0, -2)}xx`, secret)).toBeNull()
  })

  it('does not let a token of one purpose stand in for another', () => {
    expect(readOpenToken(unsubscribeToken({ userId: 'u1', kind: 'ALL' }, secret), secret)).toBeNull()
    expect(readUnsubscribeToken(openToken('del_1', '/drops', secret), secret)).toBeNull()
    expect(verifyToken('open', signToken('unsubscribe', { d: 'del_1' }, secret), secret)).toBeNull()
  })

  it('refuses an unknown kind, junk, and a token that is far too long', () => {
    expect(readUnsubscribeToken(signToken('unsubscribe', { u: 'u1', k: 'NOT_A_KIND' }, secret), secret)).toBeNull()
    expect(readUnsubscribeToken(signToken('unsubscribe', { u: 'u1' }, secret), secret)).toBeNull()
    for (const junk of ['', 'abc', 'a.b.c', '.', 'x'.repeat(2000)]) expect(readUnsubscribeToken(junk, secret)).toBeNull()
  })
})
