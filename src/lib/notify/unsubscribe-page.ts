import { POLICY } from './policy'
import { escapeHtml } from './templates'
import { t, type Locale } from './strings'
import type { UnsubscribeScope } from './tokens'

// The page an unsubscribe link opens: plain HTML, no scripts, no styles of its own (API responses carry a strict Content-Security-Policy, and the frontend can
// replace the page by pointing the links at its own route later). A real page with a heading, a sentence and a link, readable with anything.

function page(locale: Locale, title: string, lines: string[], settingsUrl: string | null): string {
  const body = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')
  const manage = settingsUrl ? `<p><a href="${escapeHtml(settingsUrl)}">${escapeHtml(t(locale, 'unsubscribe.manage'))}</a></p>` : ''
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
${manage}
</main>
</body>
</html>`
}

export function unsubscribedPage(locale: Locale, scope: UnsubscribeScope, settingsUrl: string): string {
  const line = scope.kind === 'ALL' ? t(locale, 'unsubscribe.all') : t(locale, 'unsubscribe.kind', { kindLabel: POLICY[scope.kind].label })
  return page(locale, t(locale, 'unsubscribe.title'), [line], settingsUrl)
}

export function invalidLinkPage(locale: Locale, settingsUrl: string): string {
  return page(locale, t(locale, 'unsubscribe.invalid.title'), [t(locale, 'unsubscribe.invalid.body')], settingsUrl)
}
