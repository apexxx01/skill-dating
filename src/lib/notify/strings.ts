// Every word the platform puts in an email or a push, in one place, so a language is one more table and nothing in the templates or the pipeline has to change. The
// frontend restyles the HTML later; the words stay here. Keys that end in .one / .other are the plural forms of one message (Intl.PluralRules picks).
//
// Nothing in a string may name the private mode or say what happened in it: its only lines leave through `neutral.*` (policy.ts says which kinds those are).

export const LOCALES = ['en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

const en = {
  // What may leave the app for the kinds that must not show their content (policy.ts exposure).
  'neutral.title': 'You have a new message',
  'neutral.body': 'Open the app to read it.',
  'account.title': 'You have an account notice',
  'account.body': 'Open the app to read it.',

  'email.greeting': 'Hi {name},',
  'email.greetingAnonymous': 'Hi,',
  'email.openApp': 'Open in the app',
  'email.footer.why': 'You get this email because of your notification settings ("{kindLabel}").',
  'email.footer.whyDigest': 'You get this email because you chose to receive {kindLabel}.',
  'email.footer.stopKind': 'Stop emails like this',
  'email.footer.stopAll': 'Unsubscribe from all optional email',
  'email.footer.manage': 'Manage notification settings',
  // What the footer of a neutral email calls the kind: it must not say what it is about.
  'email.footer.neutralLabel': 'message notifications',
  'email.footer.account': 'This is an account notice. It is sent whatever your notification settings say.',
  'email.preheader.neutral': 'Open the app to read it.',
  'email.skipToContent': 'Skip to the message',

  'digest.daily.name': 'the daily digest',
  'digest.weekly.name': 'the weekly digest',
  'digest.daily.subject.one': '{count} thing is waiting for you today',
  'digest.daily.subject.other': '{count} things are waiting for you today',
  'digest.daily.intro': 'Here is what is waiting for you today.',
  'digest.daily.drops.one': '{count} person picked for you today',
  'digest.daily.drops.other': '{count} people picked for you today',
  'digest.daily.drops.cta': 'See today’s Drops',
  'digest.daily.sparks.one': '{count} person sparked you',
  'digest.daily.sparks.other': '{count} people sparked you',
  'digest.daily.sparks.cta': 'See who sparked you',
  'digest.daily.registrationCloses': '{name}: registration closes {when}. You do not have a squad yet.',
  'digest.daily.submissionDue': '{name}: your squad’s submission is due {when}.',
  'digest.daily.squad.cta': 'Open your squad',
  'digest.daily.quests.one': '{count} daily quest is still open and resets at midnight',
  'digest.daily.quests.other': '{count} daily quests are still open and reset at midnight',
  'digest.daily.weeklyQuestEnds': 'Your weekly quests end {when}',
  'digest.daily.quests.cta': 'See your quests',
  'digest.section.today': 'Today',
  'digest.section.squads': 'Squads',
  'digest.section.quests': 'Quests',

  'digest.weekly.subject': 'Your week on the platform',
  'digest.weekly.intro': 'Here is your week.',
  'digest.weekly.section.shipDay': 'Ship Day',
  'digest.weekly.section.streak': 'Your streak',
  'digest.weekly.section.season': 'Season standing',
  'digest.weekly.shipDay.total.one': '{count} builder shipped on Ship Day',
  'digest.weekly.shipDay.total.other': '{count} builders shipped on Ship Day',
  'digest.weekly.shipDay.yours.one': 'You shipped {count} post and got {props} Props on it',
  'digest.weekly.shipDay.yours.other': 'You shipped {count} posts and got {props} Props on them',
  'digest.weekly.shipDay.top': 'The week’s top post: “{title}”',
  'digest.weekly.shipDay.cta': 'See the recap',
  'digest.weekly.streak.current.one': 'Your streak is {count} day',
  'digest.weekly.streak.current.other': 'Your streak is {count} days',
  'digest.weekly.streak.active': 'You were active on {active} of the last 7 days',
  'digest.weekly.streak.cta': 'See your activity',
  'digest.weekly.season.standing': 'You are #{rank} in {season} with {score} XP',
  'digest.weekly.season.cta': 'See the leaderboard',
  'digest.weekly.nothingToShow': 'A quiet week.',

  // The one-time code mailed to verify a campus address (src/lib/campus). A message the person asked for: no unsubscribe, and no mention of anything but the code.
  'campus.subject': 'Your verification code: {code}',
  'campus.title': 'Verify your campus e-mail',
  'campus.body': 'Enter this code in the app to verify your campus. It works for {minutes} minutes.',
  'campus.ignore': 'If you did not ask for this, ignore this message: nothing happens unless the code is entered.',

  // The page the unsubscribe link opens.
  'unsubscribe.title': 'You are unsubscribed',
  'unsubscribe.kind': 'You will no longer get “{kindLabel}” by email.',
  'unsubscribe.all': 'You will no longer get optional email from us. Account and safety notices still come.',
  'unsubscribe.manage': 'Change this in your notification settings',
  'unsubscribe.invalid.title': 'This link does not work',
  'unsubscribe.invalid.body': 'It may be incomplete or out of date. You can unsubscribe in your notification settings.',
} as const

export type StringKey = keyof typeof en
type Table = Record<StringKey, string>

const TABLES: Record<Locale, Table> = { en }

export type StringParams = Record<string, string | number>

function fill(template: string, params: StringParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** One message in a language, with `{name}` placeholders filled. */
export function t(locale: Locale, key: StringKey, params: StringParams = {}): string {
  return fill(TABLES[locale][key] ?? TABLES[DEFAULT_LOCALE][key], params)
}

type PluralBase<K extends string> = K extends `${infer Base}.one` ? Base : never
export type PluralKey = PluralBase<StringKey>

/** The plural form of a message that has .one and .other, for `count` (which is also available to the template as {count}). */
export function tn(locale: Locale, key: PluralKey, count: number, params: StringParams = {}): string {
  const form = new Intl.PluralRules(locale).select(count)
  const table = TABLES[locale]
  const pick = (`${key}.${form}` in table ? `${key}.${form}` : `${key}.other`) as StringKey
  return t(locale, pick, { count, ...params })
}

/** The language a person is addressed in. There is one for now; the day a user has a language setting, this reads it. */
export function localeFor(_user: { id: string } | null | undefined): Locale {
  return DEFAULT_LOCALE
}

export const stringTables = TABLES
