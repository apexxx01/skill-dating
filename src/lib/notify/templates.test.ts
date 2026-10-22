import { describe, it, expect } from 'vitest'
import { escapeHtml, renderDigestEmail, renderNotificationEmail, renderPush, visibleContent } from './templates'

const footer = { stopKindUrl: 'https://app.example.com/api/notifications/unsubscribe?t=k', stopAllUrl: 'https://app.example.com/api/notifications/unsubscribe?t=a', settingsUrl: 'https://app.example.com/settings/notifications', kindLabel: 'Comments and replies', account: false, digest: false }
const notification = { title: 'New comment', message: 'Ada: <script>alert(1)</script> & “nice”' }

describe('visibleContent', () => {
  it('shows the title and text of an ordinary notification', () => {
    expect(visibleContent('FULL', notification, 'en')).toEqual({ title: notification.title, body: notification.message })
    expect(visibleContent(undefined, notification, 'en').title).toBe('New comment')
  })

  it('shows only a neutral line for a romance notification, nothing of what it said', () => {
    const shown = visibleContent('NEUTRAL', { title: 'A private mode', message: 'You and Grace sparked each other' }, 'en')
    expect(shown).toEqual({ title: 'You have a new message', body: 'Open the app to read it.' })
    expect(JSON.stringify(shown)).not.toContain('Grace')
  })

  it('shows only that there is an account notice for a moderation one', () => {
    const shown = visibleContent('ACCOUNT', { title: 'Your account was suspended', message: 'For harassment of another member' }, 'en')
    expect(JSON.stringify(shown)).not.toMatch(/suspended|harassment/)
  })
})

describe('renderNotificationEmail', () => {
  const rendered = renderNotificationEmail({ locale: 'en', name: 'Ada Lovelace', visible: visibleContent('FULL', notification, 'en'), url: 'https://app.example.com/api/notifications/open/x', footer, neutral: false })

  it('escapes what people wrote', () => {
    expect(rendered.html).not.toContain('<script>')
    expect(rendered.html).toContain('&lt;script&gt;')
    expect(rendered.html).toContain('&amp;')
  })

  it('is a plain, accessible document: a language, a title, one h1, a descriptive link, a dark-mode style', () => {
    expect(rendered.html).toContain('<html lang="en">')
    expect(rendered.html).toContain('<title>New comment</title>')
    expect(rendered.html.match(/<h1>/g)).toHaveLength(1)
    expect(rendered.html).toContain('>Open in the app</a>')
    expect(rendered.html).toContain('prefers-color-scheme: dark')
    expect(rendered.html).not.toMatch(/<img/i)
    expect(rendered.html).toContain('width=device-width')
  })

  it('greets by first name, and carries a plain-text twin with every link written out', () => {
    expect(rendered.html).toContain('Hi Ada,')
    expect(rendered.text).toContain('Hi Ada,')
    expect(rendered.text).toContain('Open in the app: https://app.example.com/api/notifications/open/x')
    expect(rendered.text).toContain('Stop emails like this: https://app.example.com/api/notifications/unsubscribe?t=k')
    expect(rendered.text).toContain('Unsubscribe from all optional email: https://app.example.com/api/notifications/unsubscribe?t=a')
    expect(rendered.text).not.toMatch(/<(html|p|a|h1)[ >]/)
    expect(rendered.subject).toBe('New comment')
  })

  it('says why the person gets it, with a way out of this kind and of all of them', () => {
    expect(rendered.html).toContain('Comments and replies')
    expect(rendered.html).toContain('Stop emails like this')
    expect(rendered.html).toContain('Unsubscribe from all optional email')
  })

  it('has no unsubscribe link in an account notice, and says it is always sent', () => {
    const account = renderNotificationEmail({ locale: 'en', name: null, visible: { title: 'You have an account notice', body: 'Open the app to read it.' }, url: 'https://app.example.com/x', footer: { settingsUrl: footer.settingsUrl, kindLabel: 'Account notices', account: true, digest: false }, neutral: false })
    expect(account.html).not.toContain('Stop emails like this')
    expect(account.html).toContain('sent whatever your notification settings say')
    expect(account.html).toContain('Hi,')
  })

  it('shows no name and no content in the neutral line', () => {
    const neutral = renderNotificationEmail({ locale: 'en', name: 'Ada', visible: visibleContent('NEUTRAL', notification, 'en'), url: 'https://app.example.com/x', footer, neutral: true })
    expect(neutral.html).not.toContain('Ada')
    expect(neutral.text).not.toContain('Ada')
    expect(neutral.subject).toBe('You have a new message')
    expect(neutral.html).not.toContain('nice')
  })
})

describe('renderDigestEmail', () => {
  const digest = renderDigestEmail({
    locale: 'en',
    name: 'Ada',
    subject: '3 things are waiting for you today',
    intro: 'Here is what is waiting for you today.',
    sections: [
      { heading: 'Today', items: [{ text: '2 people picked for you today', url: 'https://app.example.com/drops', cta: 'See today’s Drops' }, { text: 'Hack & Co: registration closes in 2 days' }] },
    ],
    footer: { ...footer, kindLabel: 'the daily digest', digest: true },
  })

  it('lists the sections with real headings and lists, and links with words that say where', () => {
    expect(digest.html).toContain('<h2>Today</h2>')
    expect(digest.html).toContain('<ul>')
    expect(digest.html).toContain('>See today’s Drops</a>')
    expect(digest.html).toContain('Hack &amp; Co')
    expect(digest.text).toContain('TODAY')
    expect(digest.text).toContain('See today’s Drops: https://app.example.com/drops')
  })

  it('explains that the digest was chosen, not the kind', () => {
    expect(digest.html).toContain('you chose to receive the daily digest')
  })
})

describe('renderPush', () => {
  it('keeps the title and line short and carries where a tap goes', () => {
    const push = renderPush({ title: 'T'.repeat(200), body: 'B'.repeat(500) }, '/notifications', 'comment')
    expect(push.title.length).toBeLessThanOrEqual(60)
    expect(push.body.length).toBeLessThanOrEqual(120)
    expect(push).toMatchObject({ url: '/notifications', tag: 'comment' })
  })
})

describe('escapeHtml', () => {
  it('escapes the five characters that matter in HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})
