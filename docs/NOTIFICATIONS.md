# Notifications that leave the app

Notifications are written in-app by the code that causes them (a spark, a Prop, a comment, a squad invitation, a moderation decision) and always show in the
app. This document is about what happens next: which of them reach a person by **email** or **web push**, when, how often, and how a person stops them. The
code is in `src/lib/notify`, the adapters in `src/lib/infra/email.ts` and `src/lib/infra/push.ts`, the routes under `src/app/api/notifications`.

## One pipeline

Nothing that writes a notification knows about email or push. Every `Notification` has a `sweptAt` column, null until the delivery job has looked at it:

```
writers (40 places)  ->  Notification row (sweptAt NULL)
                                   |
        job notifications/deliver, every 3 minutes (src/lib/notify/dispatch.ts)
                                   |
        sweepNotifications   claims a batch (FOR UPDATE SKIP LOCKED, so two runs never take the same row)
                             -> delivery kind  (policy.ts: the kind in its metadata, else its type; romance-mode ones recognised)
                             -> decideDelivery (decide.ts, pure) per channel: SEND | DEFER | SKIP
                             -> NotificationDelivery row (the log and the lock: unique per person, channel and thing)
        releaseDeferred      sends what was held (quiet hours ended, or a failed attempt is due again)
```

Two consequences worth knowing. A notification reaches the pipeline up to three minutes after it is written (fast enough for an email, and it keeps delivery out of
every request). And a notification switched off in-app (`NotificationPreference`) is never written, so it never leaves the app either.

Notifications from before delivery existed were stamped `sweptAt = createdAt` by the migration, so turning this on mails nobody their history.

## What may leave, per kind

`src/lib/notify/policy.ts` is the table; it has a policy for every kind (`NOTIFICATION_KINDS`, every stored `NotificationType`, and the kinds other modules write
directly), and a unit test fails when one is missing. Each kind has:

| | |
|---|---|
| **class** | `SECURITY`, `ACTIVITY` or `PROMOTIONAL` (below) |
| **email, push** | the default (on or off until the person chooses), an optional rate limit, or *unavailable* (a digest by push) |
| **exposure** | `FULL` (title and text), `ACCOUNT` (only "You have an account notice"), `NEUTRAL` (only "You have a new message") |
| **group** | kinds that share one limit (all the romance kinds are one) |
| **urgency** | the push urgency (`low`, `normal`, `high`) |

**Classes.**

- `SECURITY` (moderation decisions and appeals, data exports): account and safety notices. Email and push cannot be switched off per kind or by "unsubscribe from all", ignore quiet
  hours and the channel-wide limits, carry no unsubscribe link (a link cannot switch off what the policy says is always sent), and show only that there is a notice
  (exposure `ACCOUNT`): a suspension is not for a lock screen. Only a bounced address stops them.
- `ACTIVITY`: something somebody did to the person or asked of them (a message, an invitation, a match, Props, a comment). Opt-out per kind and channel; every
  email carries an unsubscribe link.
- `PROMOTIONAL`: mail whose purpose is to sell or announce something. Needs the **MARKETING consent** (`ConsentRecord`, `POST /api/users/me/consents`) as well as
  everything an activity email needs. **Nothing is promotional today.** The two digests are account mail (`ACTIVITY`, with a cadence of their own): on by default,
  with a one-click unsubscribe per kind and for all, and no consent. *Classing them this way is a legal position: confirm in legal review before launch.* The rule stays
  in the pipeline (step 5), so a promotional kind can be added without new code, and a unit test fails if one appears by accident.

**Defaults** are conservative: email on for things a person would want to know about the same day (invitations, matches, messages, squad changes, hackathon
reminders), off for the noisy ones (Props, follows, watched projects, endorsements); push on for the same plus comments and Props, off for follows and watched
posts. Progress notices (level ups, achievements, quests, cosmetics) stay in the app. `GET /api/notifications/channels` returns every switch with its default.

## Order of the rules

`decideDelivery` applies these in order; the first that applies wins. The same function judges a held delivery again when it is released, so a choice made in the
meantime counts.

1. The kind never uses this channel (a digest by push): skip.
2. No destination: no verified address (email), or no push subscription (push): skip.
3. Email only: the address bounced or complained (`EmailSuppression`): skip, *whatever the kind*, account notices included. Recorded.
4. Not `SECURITY`: the person's global switch for the channel is off, or their choice for this kind and channel is off (else the kind's default is off): skip.
5. `PROMOTIONAL` without the MARKETING consent in force: skip.
6. Already delivered (the unique key), or the same kind about the same place (`link`) was delivered in the last hour: skip. Recorded.
7. Written more than 18 hours ago: skip (`STALE`). Recorded.
8. Not `SECURITY` and inside the person's quiet hours: **hold** until they end, in the person's own time zone (`User.timezone`, UTC when unset).
9. The kind's (or group's) limit for the channel is reached: skip (`RATE_LIMIT`). Recorded.
10. Not `SECURITY` and not on its own cadence (a digest): the channel-wide limits are reached (email 6 a day; push 3 an hour and 10 a day): skip. Recorded.
11. Send.

Skips that are the normal state of a channel nobody uses (steps 1, 2, 4, 5) leave no row. The others do, with the reason, so "why did I not get it" is answerable.

### Quiet hours

A window in the person's own day, default 22:00 to 08:00, set per person (`PUT /api/notifications/channels`), allowed to cross midnight, off with `enabled: false`.
Held deliveries are released by the same job once it ends. If more than two are due at once on one channel, the person gets one "You have N new notifications" and
the rest are marked `SUMMARISED`: a night of comments is one line at breakfast, not twelve. Nothing held for more than 18 hours is sent.

### Retries

A send the provider refused for now (a rate limit, an outage, an unreachable network) is held and tried again after 5 minutes, 15 minutes and an hour (four attempts in
all), then given up on (`FAILED`, `GAVE_UP`). A refusal for good (a bad address) is `FAILED` at once. Email carries an idempotency key per delivery, so a retry after
a lost answer cannot send twice. A push endpoint the push service reports as gone (404, 410) is deleted; a device that keeps failing is dropped after ten failures. A push
goes to the five most recently registered browsers.

### The kill switch

`kill.notification-delivery` (an admin flag, `PATCH /api/admin/flags/kill.notification-delivery`) stops all email and push at once. Notifications written while it is on
are claimed and skipped, so switching it off does not send the backlog. In-app notifications are not affected. Owner: engineering on-call.

## The romance mode

Nothing about the romance mode leaves the app except a neutral line. Every `ROMANCE_*` kind has the `NEUTRAL` exposure; a match whose `connectionType` is `DATING`, or
a message in a conversation that belongs to a `DATING` match, is recognised by the pipeline (it looks the conversation up) and treated the same. What goes out is the
title "You have a new message", the text "Open the app to read it.", and a link to `/notifications`, never to the romance screens. No name, no kind of event, no mode
name, no count. Push is on by default for these (the person opted into the mode); email is off until the person turns it on. They share one limit of three a day.
The daily digest counts only non-romance sparks (`connectionType <> 'DATING'`) and never mentions the mode. A unit test checks that no string the platform can send
names it.

## Devices (web push)

- `GET /api/notifications/push` returns the public VAPID key to subscribe with (`applicationServerKey`), whether real push is configured, and the person's devices.
- `POST /api/notifications/push` registers a browser. The body is `PushSubscription.toJSON()`: `{ endpoint, keys: { p256dh, auth }, label? }`. The same endpoint again
  refreshes it; an endpoint registered by another account moves to this one (the browser is now signed in as someone else). At most ten devices.
- `DELETE /api/notifications/push` with `{ endpoint }` is the browser unsubscribing itself; `DELETE /api/notifications/push/{id}` removes a device from the list in settings.
- The server will POST to whatever endpoint it is given, so an endpoint must be `https`, without credentials or a port, and with a real push service's host
  (`*.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) when real push is configured. The in-memory stand-in accepts any public
  https host but never calls it.
- The payload is `{ title, body, url, tag?, deliveryId }`. The service worker shows it, opens `url` on a tap, and reports the tap with
  `POST /api/notifications/deliveries/{deliveryId}/open` (the push open rate).

## Email

Plain, accessible HTML and a plain-text twin, written in `src/lib/notify/templates.ts`; every word is in `src/lib/notify/strings.ts` (one table per language,
`{name}` placeholders, `.one`/`.other` plurals) so another language is one more table. The HTML is a single column with system fonts, real headings, links that say where
they go, a touch-sized button, a dark-mode style, no images and no scripts, and the person's text escaped. The frontend restyles it later; the words stay.

Every optional email carries, in the body and in the headers:

- "Stop emails like this" (this kind) and "Unsubscribe from all optional email";
- `List-Unsubscribe: <https://…/api/notifications/unsubscribe?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so mail clients show their own button;
- why the person is getting it, and a link to their settings.

### Unsubscribe links

Signed, not stored: the token (`src/lib/notify/tokens.ts`) is `base64url(payload).HMAC-SHA256`, signed with `NOTIFICATION_SIGNING_SECRET` (or a key derived from
`CLERK_SECRET_KEY`), with the purpose part of what is signed so an unsubscribe token cannot be used as a click-through token. It never expires: a link in an old email must
keep working.

- `POST /api/notifications/unsubscribe?t=…` is what a mail client sends for the header. Answers JSON.
- `GET /api/notifications/unsubscribe?t=…` is the link in the body. Unsubscribes and shows a plain HTML confirmation page. (A scanner that follows links can therefore
  unsubscribe someone; the headers are what mail clients use, and settings can always switch a kind back on.)
- A kind link sets the person's email choice for that kind off. `ALL` sets `emailEnabled`, `dailyDigest` and `weeklyDigest` off. A `SECURITY` kind is never changed.
- Public routes, rate limited per address (30 a minute). Nothing in them needs a session.

### Click-through (email opens)

No tracking pixel: it is unreliable (mail clients preload images), and it is a privacy cost. The button and every link in an email go through
`GET /api/notifications/open/{token}`, which records `openedAt` (the first time) and redirects to the page the email was about. The destination is *signed into the
token*, so it can never be made to redirect to another site; a bad token lands at the app's front door. A mail scanner that follows links counts as an open; the
metrics say so (docs/METRICS.md).

### Bounces and complaints

`POST /api/webhooks/email` takes the email provider's events, signed (Resend signs with Svix; `RESEND_WEBHOOK_SECRET`). A permanent or undetermined bounce, or a
complaint, writes an `EmailSuppression` for the address (by address, not by account, so a new account on a dead mailbox does not start mailing it again; **only the SHA-256 of the trimmed, lower-cased address is stored, never the address**, and a database check refuses anything that is not 64 hex characters) and marks the
delivery `FAILED` (`BOUNCED` or `COMPLAINED`). A transient bounce is left to the provider's own retries. Without the secret the route answers 503. `GET
/api/notifications/channels` tells the person (`email.undeliverable`) that nothing reaches their address.

## Digests

Two emails the platform starts itself, by the hourly jobs `digests/daily` and `digests/weekly` (`src/lib/notify/digest.ts`). Both are account mail (`ACTIVITY`, see
Classes): they go to everyone who has not turned the digest or email off, has a verified address that has not bounced, and was active in the last 60 days, with no
consent needed. Every one carries the one-click unsubscribe for its kind and for all mail. Both are
**skipped when there is nothing worth sending**; the run counts them as `nothingToSend` and the day is not used up, so they are checked again at the next run.

| | when | what is worth sending |
|---|---|---|
| **daily** | once a local day, an hour after the person's drop time (09:00 by default, so 10:00), until 20:00, never in quiet hours | Drops waiting today; people who sparked them since the last digest (a **count**, never names, never the romance mode's); a squad deadline: registration closing within three days with no squad, a submission due within two days. Only beside one of those: how many daily quests are open (they reset at local midnight) and whether the weekly quests end within a day and a half. |
| **weekly** | Monday from 09:00 local until 20:00 | The person's own Ship Day (posts and Props on them) beside the week's Ship Day recap; their streak and how many of the last 7 days they were active; their season standing. A recap of other people's week with nothing of the reader's in it is not sent. |

A digest is claimed with a `NotificationDelivery` row whose key is the period (`digest:2026-10-22`, `digest:2026-W43`), so the same one is never sent twice. Every link in a
digest goes through the click-through, so its open rate is measured like any other email's. A large population is taken in batches of 500; each run enqueues the next.

## Settings API

`GET /api/notifications/channels` and `PUT /api/notifications/channels` (docs/API.md). The body of `PUT` is `{ settings?, kinds? }`:

```json
{
  "settings": { "emailEnabled": true, "pushEnabled": true, "quietHours": { "enabled": true, "start": "22:00", "end": "08:00" }, "dailyDigest": true, "weeklyDigest": true },
  "kinds": { "COMMENT": { "email": true, "push": false } }
}
```

The in-app switches stay where they were: `GET/PUT /api/notifications/preferences`.

## Operating it

- Without `RESEND_API_KEY` the email adapter is an in-memory outbox (development and tests); without `VAPID_*` push is an in-memory stand-in. Neither sends anything.
  Production should have both; setup is in docs/DEPLOY.md.
- Every send is logged by id only (`deliveryId`, `kind`), never by address or text.
- `NotificationDelivery` rows are kept 90 days (the retention job), then deleted; they hold no message content.
- Metrics read the log: send, open and act rates per channel (docs/METRICS.md).
