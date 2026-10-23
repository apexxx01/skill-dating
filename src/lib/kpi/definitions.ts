// What every number means, in words, in one place. GET /api/admin/metrics returns this beside the numbers, and docs/METRICS.md is written from it (a unit test checks that every key
// the job writes is here and every key here is in the document). Days are UTC. "Active" is defined in src/lib/kpi/activity.ts: a person who used the product that day (a product event
// of a set kind, or XP for an action of their own). The romance mode is in none of these numbers, except the demand group: how many adults asked to be told when it opens.

export type MetricUnit = 'count' | 'ratio' | 'hours' | 'per1k'

export interface MetricDefinition {
  key: string
  label: string
  group: 'North star' | 'Activity' | 'Retention' | 'Activation' | 'Matching' | 'Feed' | 'Squads and crews' | 'Notifications' | 'Safety' | 'Growth' | 'Invites' | 'Demand'
  unit: MetricUnit
  /** What the dimension of a row is, when the metric has one; absent when it is one number per day. */
  dimension?: string
  /** The exact definition: what is counted, over which window, and what is excluded. */
  definition: string
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'weekly_active_shippers',
    label: 'Weekly active shippers',
    group: 'North star',
    unit: 'count',
    definition:
      'People who showed their work in the 7 days ending with the day: made a post on the Ship Feed (not deleted or hidden), posted a project update, shipped a project, or had a squad of theirs submit to a hackathon. Each person once. Detail: how many by each route (a person can be in more than one).',
  },
  { key: 'shippers_share_of_wau', label: 'Shippers as a share of weekly actives', group: 'North star', unit: 'ratio', definition: 'Weekly active shippers divided by weekly active people.' },
  { key: 'dau', label: 'Daily active people', group: 'Activity', unit: 'count', definition: 'People who were active on the day: they used the product (see “Active” in docs/METRICS.md).' },
  { key: 'wau', label: 'Weekly active people', group: 'Activity', unit: 'count', definition: 'People who were active on at least one of the 7 days ending with the day.' },
  { key: 'mau', label: 'Monthly active people', group: 'Activity', unit: 'count', definition: 'People who were active on at least one of the 30 days ending with the day.' },
  { key: 'stickiness_dau_mau', label: 'Stickiness (DAU / MAU)', group: 'Activity', unit: 'ratio', definition: 'Daily active divided by monthly active: how much of the month a typical monthly user is there on a given day.' },
  { key: 'stickiness_wau_mau', label: 'Stickiness (WAU / MAU)', group: 'Activity', unit: 'ratio', definition: 'Weekly active divided by monthly active.' },
  { key: 'signups', label: 'Signups', group: 'Activity', unit: 'count', definition: 'Accounts made on the day that still exist.' },
  { key: 'onboarding_completed', label: 'Onboarding completed', group: 'Activity', unit: 'count', definition: 'People whose onboarding_completed event was recorded on the day (once per person: the first time onboarding became complete).' },
  { key: 'total_users', label: 'Total people', group: 'Activity', unit: 'count', definition: 'Accounts that existed at the end of the day and still do.' },
  {
    key: 'retention_d1',
    label: 'Day 1 retention',
    group: 'Retention',
    unit: 'ratio',
    dimension: 'The ISO week (UTC) people signed up in, such as 2026-W42.',
    definition:
      'Of the people who signed up in the week and whose day 1 has already come, the share who were active on the day after their signup day. A week where no one’s day 1 has come has no number. Detail: the cohort, those counted, those retained. The last 26 weeks.',
  },
  { key: 'retention_d7', label: 'Day 7 retention', group: 'Retention', unit: 'ratio', dimension: 'The ISO week (UTC) people signed up in.', definition: 'As day 1 retention, for exactly 7 days after the signup day.' },
  { key: 'retention_d30', label: 'Day 30 retention', group: 'Retention', unit: 'ratio', dimension: 'The ISO week (UTC) people signed up in.', definition: 'As day 1 retention, for exactly 30 days after the signup day.' },
  {
    key: 'activation_7d',
    label: 'Activation within 7 days',
    group: 'Activation',
    unit: 'ratio',
    dimension: 'The ISO week people finished onboarding in; empty for the last four weeks of people whose 7 days are over.',
    definition:
      'Of the people who finished onboarding and whose 7 days after it are over, the share who did a real thing in those 7 days: created a project, shipped, posted, sent a spark, gave Props, commented, used the squad builder or the solo pool, accepted a squad, submitted with a squad, or earned XP for an action of their own. Looking at drops, following and onboarding itself do not count.',
  },
  {
    key: 'onboarding_7d',
    label: 'Onboarding within 7 days of signup',
    group: 'Activation',
    unit: 'ratio',
    definition: 'Of the people who signed up 7 to 34 days before the end of the day, the share who finished onboarding within 7 days of signing up.',
  },
  {
    key: 'spark_to_match_rate',
    label: 'Spark to match',
    group: 'Matching',
    unit: 'ratio',
    definition: 'Of the sparks sent 7 to 34 days before the end of the day (each has had a week to be answered; the romance mode’s sparks are not counted), the share that became a match.',
  },
  {
    key: 'match_to_first_message_rate',
    label: 'Match to first message',
    group: 'Matching',
    unit: 'ratio',
    definition: 'Of the matches made 7 to 34 days before the end of the day (professional only), the share in which someone wrote a message, other than the platform’s icebreaker, within 7 days of the match.',
  },
  { key: 'drops_viewed_rate', label: 'Drops viewed', group: 'Matching', unit: 'ratio', definition: 'Of the drops made in the 8 days up to the end of the day before, the share that were looked at.' },
  { key: 'drops_acted_rate', label: 'Drops acted on', group: 'Matching', unit: 'ratio', definition: 'Of the same drops, the share that were answered with a spark or a pass.' },
  {
    key: 'props_per_post',
    label: 'Props per post',
    group: 'Feed',
    unit: 'count',
    definition: 'The Props received so far by posts made 3 to 9 days before the end of the day (not deleted or hidden), divided by the number of those posts. Detail: the posts and the Props.',
  },
  {
    key: 'ship_day_participation',
    label: 'Ship Day participation',
    group: 'Feed',
    unit: 'ratio',
    dimension: 'The ISO week of the latest Ship Day recap.',
    definition: 'People who posted on the latest Ship Day, divided by people active in the 7 days ending that Friday.',
  },
  {
    key: 'hackathon_squad_rate',
    label: 'Hackathon participants in a squad',
    group: 'Squads and crews',
    unit: 'ratio',
    definition: 'Over hackathons that ended in the last 90 days: of the people registered (not those who withdrew), the share who ended in a squad.',
  },
  {
    key: 'time_to_squad_median_hours',
    label: 'Median time to a squad (hours)',
    group: 'Squads and crews',
    unit: 'hours',
    definition: 'Over the same hackathons: the median of the hours from registering to joining a squad, for the people who joined one. Detail: the 90th percentile.',
  },
  {
    key: 'squads_submitted_rate',
    label: 'Squads that submitted',
    group: 'Squads and crews',
    unit: 'ratio',
    definition: 'Over the same hackathons: the share of squads in which a member’s registration is marked submitted.',
  },
  {
    key: 'crews_shipped_30d_rate',
    label: 'Crews that ship within 30 days',
    group: 'Squads and crews',
    unit: 'ratio',
    definition: 'Of the crews made 30 to 59 days before the end of the day, the share that shipped within 30 days of being made: a post by the crew or on its project, or its project marked shipped.',
  },
  {
    key: 'delivery_open_rate',
    label: 'Email and push open rate',
    group: 'Notifications',
    unit: 'ratio',
    dimension: 'EMAIL, PUSH, DIGEST_DAILY or DIGEST_WEEKLY.',
    definition:
      'Of the messages sent 2 to 29 days before the end of the day, the share opened within 48 hours: an email by a click on it (no tracking pixel is used, and a mail scanner that follows links counts as a click), a push by a tap reported by the service worker. The digests are counted apart from other email.',
  },
  {
    key: 'delivery_act_rate',
    label: 'Email and push act rate',
    group: 'Notifications',
    unit: 'ratio',
    dimension: 'EMAIL, PUSH, DIGEST_DAILY or DIGEST_WEEKLY.',
    definition: 'Of the same messages, the share that were opened and then followed within 30 minutes by a real thing done (as in activation).',
  },
  { key: 'email_bounce_rate', label: 'Email bounce rate', group: 'Notifications', unit: 'ratio', definition: 'Of the emails the provider took in the same window, the share that bounced for good.' },
  { key: 'email_complaint_rate', label: 'Email complaint rate', group: 'Notifications', unit: 'ratio', definition: 'Of the same emails, the share the recipient reported as spam.' },
  {
    key: 'reports_per_1k_wau',
    label: 'Reports per 1,000 weekly actives',
    group: 'Safety',
    unit: 'per1k',
    definition: 'Reports filed by people (not the platform’s own) in the 7 days ending with the day, per 1,000 people active in them.',
  },
  {
    key: 'moderation_time_to_action_median_hours',
    label: 'Median time to resolve a report (hours)',
    group: 'Safety',
    unit: 'hours',
    definition: 'The median of the hours from a report being filed to its resolution, for reports resolved in the 28 days ending with the day. Detail: the 90th percentile and how many.',
  },
  {
    key: 'moderation_open_reports',
    label: 'Open reports',
    group: 'Safety',
    unit: 'count',
    definition: 'Reports not yet resolved at the end of the day. Detail: the age in hours of the oldest.',
  },
  {
    key: 'users_by_place',
    label: 'People by place',
    group: 'Growth',
    unit: 'count',
    dimension: 'country:IN, city:IN:pune or campus:iisc-bangalore (a verified campus).',
    definition: 'Accounts by the place on their profile, at the end of the day. The 50 largest of each kind, only places with at least 3 people; people who gave none are in none; minors share a country only.',
  },
  { key: 'signups_7d_by_place', label: 'Signups by place (7 days)', group: 'Growth', unit: 'count', dimension: 'As people by place.', definition: 'Accounts made in the 7 days ending with the day, by the same places, for places with at least one.' },
  {
    key: 'invites_per_active_user_28d',
    label: 'Invites per active person',
    group: 'Invites',
    unit: 'ratio',
    definition: 'Invite codes redeemed in the 28 days ending with the day, divided by people active in the 30 days ending with it.',
  },
  {
    key: 'invite_conversion_14d',
    label: 'Invite conversion',
    group: 'Invites',
    unit: 'ratio',
    dimension: 'Empty for all codes, PERSONAL or CAMPAIGN.',
    definition: 'Of the codes redeemed 14 to 41 days before the end of the day, the share whose invitee got started (finished onboarding and did a first real thing) within 14 days of joining. Rejected invites count as not started.',
  },
  {
    key: 'romance_interest',
    label: 'Asked to be told when the romance mode opens',
    group: 'Demand',
    unit: 'count',
    dimension: 'Empty for everybody, or city:IN:pune (the country and city kept with the request).',
    definition:
      'Adults who asked to be told when the romance mode opens (and have not withdrawn the request) by the end of the day. By city: the 50 largest, only cities with at least 3 people. The mode ships closed; this is the demand signal that decides where it opens first.',
  },
  {
    key: 'romance_interest_share_of_adult_actives',
    label: 'Interest as a share of adult actives',
    group: 'Demand',
    unit: 'ratio',
    dimension: 'Empty for everybody, or city:IN:pune.',
    definition:
      'People who asked to be told, divided by the adults (18 or older, date of birth on file) who were active in the last 30 days in the same place (everyone, or the city on their profile). It can pass 1: a person can ask without having been active lately. Detail: both counts.',
  },
] as const

export const METRIC_KEYS: readonly string[] = METRIC_DEFINITIONS.map((definition) => definition.key)

export const definitionOf = (key: string): MetricDefinition | undefined => METRIC_DEFINITIONS.find((definition) => definition.key === key)
