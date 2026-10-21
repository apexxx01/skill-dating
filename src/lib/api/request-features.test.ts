import { describe, it, expect } from 'vitest'
import { closedAccountAllows, featureOfRequest } from './request-features'

describe('featureOfRequest', () => {
  it('maps writes to the messaging, posting and external hackathon features', () => {
    expect(featureOfRequest('POST', '/api/conversations')).toBe('messaging')
    expect(featureOfRequest('POST', '/api/conversations/c1')).toBe('messaging')
    expect(featureOfRequest('PATCH', '/api/messages/m1')).toBe('messaging')
    expect(featureOfRequest('POST', '/api/messages/m1/reactions')).toBe('messaging')
    expect(featureOfRequest('POST', '/api/posts')).toBe('posting')
    expect(featureOfRequest('PATCH', '/api/posts/p1')).toBe('posting')
    expect(featureOfRequest('POST', '/api/posts/p1/comments')).toBe('posting')
    expect(featureOfRequest('POST', '/api/hackathons/h1/lfg')).toBe('posting')
    expect(featureOfRequest('POST', '/api/teams/t1/ideas')).toBe('posting')
    expect(featureOfRequest('POST', '/api/teams/t1/demo-post')).toBe('posting')
    expect(featureOfRequest('POST', '/api/hackathons/external')).toBe('external_hackathons')
  })

  it('never blocks reading, deleting your own post, or marking a conversation read', () => {
    expect(featureOfRequest('GET', '/api/posts')).toBeNull()
    expect(featureOfRequest('GET', '/api/conversations/c1')).toBeNull()
    expect(featureOfRequest('DELETE', '/api/posts/p1')).toBeNull()
    expect(featureOfRequest('POST', '/api/conversations/c1/read')).toBeNull()
    expect(featureOfRequest('POST', '/api/posts/p1/props')).toBeNull()
  })

  it('covers the whole romance mode except leaving it', () => {
    expect(featureOfRequest('GET', '/api/romance/drop')).toBe('romance')
    expect(featureOfRequest('PUT', '/api/romance/profile')).toBe('romance')
    expect(featureOfRequest('DELETE', '/api/romance/profile')).toBeNull()
  })
})

describe('closedAccountAllows', () => {
  it('leaves a suspended person their account, their data, appeals and notices', () => {
    for (const [method, path] of [['GET', '/api/users/me'], ['POST', '/api/appeals'], ['GET', '/api/appeals'], ['GET', '/api/users/me/moderation'], ['GET', '/api/users/me/export'], ['DELETE', '/api/users/me'], ['GET', '/api/notifications']]) {
      expect(closedAccountAllows(method, path)).toBe(true)
    }
  })

  it('closes everything else', () => {
    expect(closedAccountAllows('POST', '/api/posts')).toBe(false)
    expect(closedAccountAllows('GET', '/api/feed')).toBe(false)
    expect(closedAccountAllows('PATCH', '/api/users/me/profile')).toBe(false)
  })
})
