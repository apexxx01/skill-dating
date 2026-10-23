# Metrics

The numbers a founder, an investor or a board asks for, measured every night and kept as rows you can chart, export and audit. They are for **admins only** (`GET /api/admin/metrics`,
`GET /api/admin/metrics/export.csv`). Nothing here names a person: a row is a number for a day, a key, and sometimes a dimension (a cohort week, a channel, a place).

The code is in `src/lib/kpi`; the definitions below are generated from `src/lib/kpi/definitions.ts`, which is also what the API returns beside the numbers, and a unit test keeps the three
in step (every metric the job writes is defined, every definition is in this document).

## How it is measured

- **The job.** `metrics/snapshot` runs at 01:20 UTC and measures the day that just ended (UTC). It first records who was active (below), then computes each group of metrics, then writes the day's
  rows (`MetricsSnapshot`: day, key, dimension, value, detail). Each group is measured on its own; one that fails is logged and left out of that day, and the rows an earlier run of the day
  wrote for it stay. Re-running a day replaces it whole. `POST /api/admin/jobs/metrics/snapshot` with `{ "data": { "day": "2026-10-21", "backfillDays": 90 } }` measures another day
  or fills the activity base further back; the first run fills 90 days.
- **Days are UTC.** A day runs from 00:00 UTC to the next 00:00 UTC. "The last 7 days" is the 7 days that end with the day measured. This is deliberately not each person's local day (streaks and
  quests are): a metric must mean the same thing for everyone, and an hourly job could not make it so otherwise.
- **Windows that need time to pass.** A rate whose outcome takes time (a spark has to be answered, an invitee has to get started) is measured over people or events old enough to have had that time,
  and says so in its definition. The numbers for a recent window are therefore about a slightly older group; that is the price of a number that does not rise for weeks after it was written.
- **Accounts that are deleted are not counted**, in the numerators or the denominators. The system account is one of them.
- **The romance mode is in none of these numbers.** Its sparks, matches, messages and events are filtered out of every metric (`connectionType <> 'DATING'`, and no `romance_*` event is in the list of
  activity); no table of it is read.
- **Places are reported only above 3 people** (country, city, verified campus), 50 of each kind, so a count cannot point at a person.
- **Limits of the numbers.** Activity is built from the product events (13 months kept) and the XP log, written by the application inside the action itself; an action that wrote neither (reading, in
  most cases) is not activity. An analytics write that failed (it never fails the action) is a missed event. Email opens are click-throughs, not pixel loads: no pixel is used, and a mail scanner that
  follows links counts as an open.

## Active

**A person is active on a day** when, that UTC day, they had a product event of one of these kinds, or were paid XP for an action of their own:

- product events: `signup`, `onboarding_completed`, `project_created`, `project_shipped`, `drop_viewed`, `spark_sent`, `post_created`, `props_given`, `comment_created`, `follow_created`,
  `squad_builder_used`, `squad_proposal_accepted`, `solo_pool_joined`, `squad_submitted`;
- XP for an action of their own (reward rules with `streak: true`): `PROJECT_CREATED`, `PROJECT_SHIP`, `HACKATHON_JOIN`, `TEAM_FORMED`, `MILESTONE_COMPLETED`, `PROJECT_UPDATE_POSTED`,
  `EVIDENCE_ADDED`, `CONNECTION_ACCEPTED`, `MESSAGE_SENT_FIRST_IN_CONNECTION`, `SQUAD_SUBMITTED`. Not Props received, an endorsement, an accepted application, a win, an achievement or a quest: those
  are things other people, or a reward, did for the person.

Those days are written to `ActivityDay` (one row per person per day, kept 25 months) by the job, which is what lets retention be computed long after the events behind it are deleted.

**A real thing done** (activation, invites, and what follows an opened email) is narrower: `project_created`, `project_shipped`, `post_created`, `spark_sent`, `props_given`, `comment_created`,
`squad_builder_used`, `squad_proposal_accepted`, `solo_pool_joined`, `squad_submitted`, or XP for an action of the person's own. Looking at drops, following someone and finishing onboarding itself
do not count.

## The north star: weekly active shippers

The number the company is steered by is **people who showed their work in a week**: not who logged in, but who made something visible. It is `weekly_active_shippers`, with its share of weekly
actives beside it (`shippers_share_of_wau`) so that growth in shippers can be told from growth in visitors. A person is a shipper if, in the 7 days ending with the day, they made a post on the Ship Feed
(not deleted or hidden), posted a project update, shipped a project, or had a squad of theirs submit to a hackathon.

## Definitions

### North star

**`weekly_active_shippers`** — Weekly active shippers (count)

People who showed their work in the 7 days ending with the day: made a post on the Ship Feed (not deleted or hidden), posted a project update, shipped a project, or had a squad of theirs submit to a hackathon. Each person once. Detail: how many by each route (a person can be in more than one).

**`shippers_share_of_wau`** — Shippers as a share of weekly actives (ratio)

Weekly active shippers divided by weekly active people.

### Activity

**`dau`** — Daily active people (count)

People who were active on the day: they used the product (see “Active” in docs/METRICS.md).

**`wau`** — Weekly active people (count)

People who were active on at least one of the 7 days ending with the day.

**`mau`** — Monthly active people (count)

People who were active on at least one of the 30 days ending with the day.

**`stickiness_dau_mau`** — Stickiness (DAU / MAU) (ratio)

Daily active divided by monthly active: how much of the month a typical monthly user is there on a given day.

**`stickiness_wau_mau`** — Stickiness (WAU / MAU) (ratio)

Weekly active divided by monthly active.

**`signups`** — Signups (count)

Accounts made on the day that still exist.

**`onboarding_completed`** — Onboarding completed (count)

People whose onboarding_completed event was recorded on the day (once per person: the first time onboarding became complete).

**`total_users`** — Total people (count)

Accounts that existed at the end of the day and still do.

### Retention

**`retention_d1`** — Day 1 retention (ratio)

Of the people who signed up in the week and whose day 1 has already come, the share who were active on the day after their signup day. A week where no one’s day 1 has come has no number. Detail: the cohort, those counted, those retained. The last 26 weeks.

*Dimension:* The ISO week (UTC) people signed up in, such as 2026-W42.

**`retention_d7`** — Day 7 retention (ratio)

As day 1 retention, for exactly 7 days after the signup day.

*Dimension:* The ISO week (UTC) people signed up in.

**`retention_d30`** — Day 30 retention (ratio)

As day 1 retention, for exactly 30 days after the signup day.

*Dimension:* The ISO week (UTC) people signed up in.

### Activation

**`activation_7d`** — Activation within 7 days (ratio)

Of the people who finished onboarding and whose 7 days after it are over, the share who did a real thing in those 7 days: created a project, shipped, posted, sent a spark, gave Props, commented, used the squad builder or the solo pool, accepted a squad, submitted with a squad, or earned XP for an action of their own. Looking at drops, following and onboarding itself do not count.

*Dimension:* The ISO week people finished onboarding in; empty for the last four weeks of people whose 7 days are over.

**`onboarding_7d`** — Onboarding within 7 days of signup (ratio)

Of the people who signed up 7 to 34 days before the end of the day, the share who finished onboarding within 7 days of signing up.

### Matching

**`spark_to_match_rate`** — Spark to match (ratio)

Of the sparks sent 7 to 34 days before the end of the day (each has had a week to be answered; the romance mode’s sparks are not counted), the share that became a match.

**`match_to_first_message_rate`** — Match to first message (ratio)

Of the matches made 7 to 34 days before the end of the day (professional only), the share in which someone wrote a message, other than the platform’s icebreaker, within 7 days of the match.

**`drops_viewed_rate`** — Drops viewed (ratio)

Of the drops made in the 8 days up to the end of the day before, the share that were looked at.

**`drops_acted_rate`** — Drops acted on (ratio)

Of the same drops, the share that were answered with a spark or a pass.

### Feed

**`props_per_post`** — Props per post (count)

The Props received so far by posts made 3 to 9 days before the end of the day (not deleted or hidden), divided by the number of those posts. Detail: the posts and the Props.

**`ship_day_participation`** — Ship Day participation (ratio)

People who posted on the latest Ship Day, divided by people active in the 7 days ending that Friday.

*Dimension:* The ISO week of the latest Ship Day recap.

### Squads and crews

**`hackathon_squad_rate`** — Hackathon participants in a squad (ratio)

Over hackathons that ended in the last 90 days: of the people registered (not those who withdrew), the share who ended in a squad.

**`time_to_squad_median_hours`** — Median time to a squad (hours) (hours)

Over the same hackathons: the median of the hours from registering to joining a squad, for the people who joined one. Detail: the 90th percentile.

**`squads_submitted_rate`** — Squads that submitted (ratio)

Over the same hackathons: the share of squads in which a member’s registration is marked submitted.

**`crews_shipped_30d_rate`** — Crews that ship within 30 days (ratio)

Of the crews made 30 to 59 days before the end of the day, the share that shipped within 30 days of being made: a post by the crew or on its project, or its project marked shipped.

### Notifications

**`delivery_open_rate`** — Email and push open rate (ratio)

Of the messages sent 2 to 29 days before the end of the day, the share opened within 48 hours: an email by a click on it (no tracking pixel is used, and a mail scanner that follows links counts as a click), a push by a tap reported by the service worker. The digests are counted apart from other email.

*Dimension:* EMAIL, PUSH, DIGEST_DAILY or DIGEST_WEEKLY.

**`delivery_act_rate`** — Email and push act rate (ratio)

Of the same messages, the share that were opened and then followed within 30 minutes by a real thing done (as in activation).

*Dimension:* EMAIL, PUSH, DIGEST_DAILY or DIGEST_WEEKLY.

**`email_bounce_rate`** — Email bounce rate (ratio)

Of the emails the provider took in the same window, the share that bounced for good.

**`email_complaint_rate`** — Email complaint rate (ratio)

Of the same emails, the share the recipient reported as spam.

### Safety

**`reports_per_1k_wau`** — Reports per 1,000 weekly actives (per1k)

Reports filed by people (not the platform’s own) in the 7 days ending with the day, per 1,000 people active in them.

**`moderation_time_to_action_median_hours`** — Median time to resolve a report (hours) (hours)

The median of the hours from a report being filed to its resolution, for reports resolved in the 28 days ending with the day. Detail: the 90th percentile and how many.

**`moderation_open_reports`** — Open reports (count)

Reports not yet resolved at the end of the day. Detail: the age in hours of the oldest.

### Growth

**`users_by_place`** — People by place (count)

Accounts by the place on their profile, at the end of the day. The 50 largest of each kind, only places with at least 3 people; people who gave none are in none; minors share a country only.

*Dimension:* country:IN, city:IN:pune or campus:iisc-bangalore (a verified campus).

**`signups_7d_by_place`** — Signups by place (7 days) (count)

Accounts made in the 7 days ending with the day, by the same places, for places with at least one.

*Dimension:* As people by place.

### Invites

**`invites_per_active_user_28d`** — Invites per active person (ratio)

Invite codes redeemed in the 28 days ending with the day, divided by people active in the 30 days ending with it.

**`invite_conversion_14d`** — Invite conversion (ratio)

Of the codes redeemed 14 to 41 days before the end of the day, the share whose invitee got started (finished onboarding and did a first real thing) within 14 days of joining. Rejected invites count as not started.

*Dimension:* Empty for all codes, PERSONAL or CAMPAIGN.

### Demand

**`romance_interest`** — Asked to be told when the romance mode opens (count)

Adults who asked to be told when the romance mode opens (and have not withdrawn the request) by the end of the day. By city: the 50 largest, only cities with at least 3 people. The mode ships closed; this is the demand signal that decides where it opens first.

*Dimension:* Empty for everybody, or city:IN:pune (the country and city kept with the request).

**`romance_interest_share_of_adult_actives`** — Interest as a share of adult actives (ratio)

People who asked to be told, divided by the adults (18 or older, date of birth on file) who were active in the last 30 days in the same place (everyone, or the city on their profile). It can pass 1: a person can ask without having been active lately. Detail: both counts.

*Dimension:* Empty for everybody, or city:IN:pune.

## Reading the retention table

`retention_d1`, `retention_d7` and `retention_d30` come with one row per signup week (the dimension). Each night's snapshot holds the whole table for the last 26 weeks as it stands that night, so
the latest day's rows are the current table, and an earlier day's rows show what it was then. A cohort's day-N number stops changing once every person's day N has passed. This is classic day-N
retention (active **on** day N), not "active at any point after"; the unbounded kind is easy to read off `ActivityDay` and is not stored.

## Where each number is computed

| Group | Function |
| --- | --- |
| Activity, north star | `activityMetrics` (`src/lib/kpi/compute-activity.ts`) |
| Retention | `retentionMetrics` |
| Activation, onboarding | `activationMetrics`, `onboardingRate` |
| Matching | `matchingMetrics` (`src/lib/kpi/compute-product.ts`) |
| Feed | `feedMetrics` |
| Squads and crews | `squadMetrics` |
| Notifications | `deliveryMetrics` (`src/lib/kpi/compute-ops.ts`) |
| Safety | `safetyMetrics` |
| Growth | `growthMetrics` |
| Invites | `inviteMetrics` |
| Demand | `demandMetrics` |

`tests/integration/metrics.test.ts` builds a database with known rows and checks every metric against the number worked out by hand; read it for a worked example of each definition.

## The API

`GET /api/admin/metrics?from=2026-10-01&to=2026-10-21&keys=weekly_active_shippers,retention_d7` answers

```json
{
  "from": "2026-10-01", "to": "2026-10-21", "computedThrough": "2026-10-21", "truncated": false,
  "definitions": [ { "key": "weekly_active_shippers", "label": "...", "group": "North star", "unit": "count", "definition": "..." } ],
  "rows": [ { "day": "2026-10-21", "key": "weekly_active_shippers", "dimension": "", "value": 412, "detail": { "posts": 380, "projectUpdates": 90, "shipped": 12 } } ]
}
```

Without `from` and `to` it is the last 30 days that are over; a range is at most 366 days and 50,000 rows (`truncated` says when it was cut). `/api/admin/metrics/export.csv` has the same query and answers
`day,key,dimension,value,detail`, with the detail as JSON; cells that start with a character a spreadsheet would run as a formula are neutralised.

## Operating it

- The job needs Inngest in production like every other scheduled job. Without it, run it from `POST /api/admin/jobs/metrics/snapshot` or a scheduler of your own.
- The activity base grows by about one row per active person per day. At a million daily actives that is a billion rows a year, which is the point to partition `ActivityDay` by month or move the
  retention queries to a warehouse; the table is deliberately only `(userId, day)` so that move is a copy.
- Several queries look back 30 to 90 days over `ProductEvent`, `XPEvent`, `Spark` and `ShipPost`; each is indexed by time. A slow run is a signal to read the query plan, not to widen a window.
- Nothing here changes what a person sees or gets; it only reads. Deleting an account deletes its `ActivityDay` rows (the snapshots hold no person).
