import type { PushPayload } from '@/lib/infra/push.contract'
import type { KindPolicy } from './policy'
import { t, type Locale } from './strings'

// The HTML and plain-text bodies of the emails, and the line of a push. Brand-neutral and deliberately plain: a single column, system fonts, real headings and links,
// text that stays readable with images off (there are none) and in a dark mode, links with their destination in the words, a touch-sized button. The frontend
// restyles them later; the words are in strings.ts. Everything that came from a person is escaped. Pure functions: the pipeline hands them values and sends what they return.

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const truncate = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`)

/** What is said in an email or a push, once the kind's exposure has decided how much may be. */
export interface Visible {
  title: string
  body: string
}

/** The title and text that may leave the app for this kind (policy.ts exposure). */
export function visibleContent(exposure: KindPolicy['exposure'], notification: { title: string; message: string }, locale: Locale): Visible {
  if (exposure === 'NEUTRAL') return { title: t(locale, 'neutral.title'), body: t(locale, 'neutral.body') }
  if (exposure === 'ACCOUNT') return { title: t(locale, 'account.title'), body: t(locale, 'account.body') }
  return { title: notification.title, body: notification.message }
}

export interface FooterLinks {
  /** "Stop emails like this": the kind's one-click unsubscribe. Absent for an account notice. */
  stopKindUrl?: string
  /** "Unsubscribe from all optional email". Absent for an account notice. */
  stopAllUrl?: string
  settingsUrl: string
  /** What the person chose to get: "Comments and replies", "the daily digest". */
  kindLabel: string
  /** Whether it is an account notice (always sent). */
  account: boolean
  /** A digest is chosen as a whole; an activity email by its kind. */
  digest: boolean
}

const STYLE = `
  body{margin:0;padding:0;background:#f4f4f5;color:#18181b;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:24px 16px}
  .card{background:#ffffff;border-radius:8px;padding:24px}
  h1{font-size:20px;line-height:1.3;margin:0 0 16px}
  h2{font-size:16px;line-height:1.4;margin:24px 0 8px}
  p{margin:0 0 16px}
  ul{margin:0 0 16px;padding-left:20px}
  li{margin:0 0 8px}
  a{color:#0b57d0}
  .button{display:inline-block;background:#0b57d0;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px;min-height:20px}
  .footer{font-size:14px;line-height:1.5;color:#52525b;padding:16px 8px 0}
  .footer a{color:#3f3f46}
  .pre{display:none;max-height:0;overflow:hidden;opacity:0;color:transparent}
  @media (prefers-color-scheme: dark){body{background:#18181b;color:#f4f4f5}.card{background:#27272a}a{color:#8ab4f8}.button{background:#8ab4f8;color:#0b1b33}.footer{color:#a1a1aa}.footer a{color:#d4d4d8}}
`

function footerHtml(footer: FooterLinks, locale: Locale): string {
  const why = footer.account
    ? t(locale, 'email.footer.account')
    : t(locale, footer.digest ? 'email.footer.whyDigest' : 'email.footer.why', { kindLabel: footer.kindLabel })
  const links: string[] = []
  if (footer.stopKindUrl) links.push(`<a href="${escapeHtml(footer.stopKindUrl)}">${escapeHtml(t(locale, 'email.footer.stopKind'))}</a>`)
  if (footer.stopAllUrl) links.push(`<a href="${escapeHtml(footer.stopAllUrl)}">${escapeHtml(t(locale, 'email.footer.stopAll'))}</a>`)
  links.push(`<a href="${escapeHtml(footer.settingsUrl)}">${escapeHtml(t(locale, 'email.footer.manage'))}</a>`)
  return `<div class="footer"><p>${escapeHtml(why)}</p><p>${links.join(' · ')}</p></div>`
}

function footerText(footer: FooterLinks, locale: Locale): string {
  const why = footer.account ? t(locale, 'email.footer.account') : t(locale, footer.digest ? 'email.footer.whyDigest' : 'email.footer.why', { kindLabel: footer.kindLabel })
  const lines = [why]
  if (footer.stopKindUrl) lines.push(`${t(locale, 'email.footer.stopKind')}: ${footer.stopKindUrl}`)
  if (footer.stopAllUrl) lines.push(`${t(locale, 'email.footer.stopAll')}: ${footer.stopAllUrl}`)
  lines.push(`${t(locale, 'email.footer.manage')}: ${footer.settingsUrl}`)
  return lines.join('\n')
}

function page(locale: Locale, title: string, preheader: string, bodyHtml: string, footer: FooterLinks): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<span class="pre">${escapeHtml(preheader)}</span>
<div class="wrap" role="article" aria-roledescription="email" lang="${locale}">
<div class="card">
${bodyHtml}
</div>
${footerHtml(footer, locale)}
</div>
</body>
</html>`
}

export interface NotificationEmailInput {
  locale: Locale
  name: string | null
  visible: Visible
  /** The absolute link the button opens (the tracked click-through). */
  url: string
  footer: FooterLinks
  /** Whether the content is the neutral line: no greeting by name, nothing else. */
  neutral: boolean
}

export function renderNotificationEmail(input: NotificationEmailInput): RenderedEmail {
  const { locale, visible } = input
  const greeting = input.neutral ? '' : input.name ? t(locale, 'email.greeting', { name: input.name.split(/\s+/)[0] }) : t(locale, 'email.greetingAnonymous')
  const body = truncate(visible.body, 600)
  const open = t(locale, 'email.openApp')
  const html = page(
    locale,
    visible.title,
    input.neutral ? t(locale, 'email.preheader.neutral') : truncate(body, 100),
    [
      `<h1>${escapeHtml(visible.title)}</h1>`,
      greeting ? `<p>${escapeHtml(greeting)}</p>` : '',
      `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
      `<p><a class="button" href="${escapeHtml(input.url)}">${escapeHtml(open)}</a></p>`,
    ]
      .filter(Boolean)
      .join('\n'),
    input.footer
  )
  const text = [visible.title, '', greeting, greeting ? '' : null, body, '', `${open}: ${input.url}`, '', '--', footerText(input.footer, locale)].filter((line) => line !== null).join('\n')
  return { subject: visible.title, html, text }
}

export interface DigestItem {
  text: string
  /** Where the item goes, absolute. */
  url?: string
  cta?: string
}

export interface DigestSection {
  heading: string
  items: DigestItem[]
}

export interface DigestEmailInput {
  locale: Locale
  name: string | null
  subject: string
  intro: string
  sections: DigestSection[]
  footer: FooterLinks
}

export function renderDigestEmail(input: DigestEmailInput): RenderedEmail {
  const { locale } = input
  const greeting = input.name ? t(locale, 'email.greeting', { name: input.name.split(/\s+/)[0] }) : t(locale, 'email.greetingAnonymous')
  const sectionsHtml = input.sections
    .map((section) => {
      const items = section.items
        .map((item) => {
          if (!item.url) return `<li>${escapeHtml(item.text)}</li>`
          // With a call to action the sentence stands alone and the link follows it; without one the sentence is the link.
          if (item.cta) return `<li>${escapeHtml(item.text)}. <a href="${escapeHtml(item.url)}">${escapeHtml(item.cta)}</a></li>`
          return `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.text)}</a></li>`
        })
        .join('\n')
      return `<h2>${escapeHtml(section.heading)}</h2>\n<ul>\n${items}\n</ul>`
    })
    .join('\n')
  const html = page(locale, input.subject, input.intro, [`<h1>${escapeHtml(input.subject)}</h1>`, `<p>${escapeHtml(greeting)} ${escapeHtml(input.intro)}</p>`, sectionsHtml].join('\n'), input.footer)
  const textSections = input.sections.map((section) => [section.heading.toUpperCase(), ...section.items.map((item) => `- ${item.text}${item.url ? `\n  ${item.cta ?? ''}${item.cta ? ': ' : ''}${item.url}` : ''}`)].join('\n'))
  const text = [input.subject, '', `${greeting} ${input.intro}`, '', textSections.join('\n\n'), '', '--', footerText(input.footer, locale)].join('\n')
  return { subject: input.subject, html, text }
}

/** The push for a notification: a short title and one line, and where a tap goes. */
export function renderPush(visible: Visible, url: string, tag?: string): PushPayload {
  return { title: truncate(visible.title, 60), body: truncate(visible.body, 120), url, ...(tag ? { tag } : {}) }
}
