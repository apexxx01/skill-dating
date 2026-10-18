# Posts, Props and the Feed

Builders show what they made. A **post** is a SHIP, an UPDATE, a DEVLOG or a DEMO; people give it **Props**, comment on it, and see it in a **feed**. Friday is **Ship Day**. The routes are in [API.md](API.md#posts--feed), the rewards in [GAMIFICATION.md](GAMIFICATION.md), and the screens in [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md). Nothing here touches the romance mode: a romance match is never a "match" for the feed (`professionalMatchIds` leaves it out), and no romance data is read.

## Posts

| Kind | What it is | Needs | Pays |
| --- | --- | --- | --- |
| `SHIP` | "I shipped this" | a project the author belongs to | the project's ship XP, **once** per project (below) |
| `UPDATE` | progress on a project | a project | counts as a project update: the existing XP and daily cap |
| `DEVLOG` | a longer build log | a project | the same as an update |
| `DEMO` | something to look at | nothing | nothing |

- **Context.** A post can be about a project (`projectId`) or a crew (`teamId`). The author must be a member of it. Co-authors (up to 5) must be members too and must not have a block with the author. A co-author shares the credit: the post is on their timeline and they cannot edit it.
- **Body.** Markdown, up to 10,000 characters, sanitized on write (`src/lib/posts/sanitize.ts`): no raw HTML, no scripts, no images by URL (media goes through uploads), only `http` and `https` links, link text kept, nothing that survives as markup. The title is a single line of plain text, 3 to 120 characters. Links are an extra list of at most 5 public URLs.
- **Media.** Up to 6 images, GIFs or videos, **uploaded first** through `/api/media/uploads` with purpose `POST_MEDIA` (see ARCHITECTURE: presigned uploads straight to the bucket, confirmed with `HEAD`). A post names confirmed uploads of its author by id; anything else is `MEDIA_NOT_FOUND`. Reads use the public base URL when one is configured, otherwise a short-lived signed URL.
- **Visibility.** `PUBLIC` (everyone), `FOLLOWERS` (the author's followers, co-authors and the author), `CREW` (members of the post's project or crew). Whatever the viewer may not see is **"not found"**, the same as a deleted post, so a post cannot be found by probing. A block in either direction hides the author's posts in every list.
- **Edit and delete.** The author can change the title, body, links, stack tags and visibility; `revision` counts the edits and `editedAt` is set. Delete is a soft delete (`deletedAt`): the post leaves every list at once and its Props and comments stay in the table. An admin can delete too.
- **One ship gate.** A project ships once, whatever route did it. `shipProjectOnce` (`src/lib/ship.ts`) sets `shippedAt` only while it is empty and then records the ship; the project PATCH goes through the same function. A SHIP post for a project that has not shipped ships it and pays; a second SHIP post for it is a plain post. There is no second award path, and `grant()` remains the only writer of XP.
- **Idempotency.** Creating a post, Props, a comment, a follow and a watch honour `Idempotency-Key`.

## Props

A Prop is respect from one builder for a post. One per person per post; never your own (or one you co-authored).

**Weight.** Worked out when the Prop is given and **stored on the row**, never recomputed; a post's `propsScore` is the sum of its weights, kept in step in the same transaction (so it is exact, and reading a feed never aggregates).

```
weight = tierFactor * ageFactor * verificationFactor        (0 for a giver the trust gate does not trust)

tierFactor          1.0 for Bronze, +0.25 for each tier above (Mythic 2.25)
ageFactor           0.4 for a brand-new account, rising evenly to 1.0 at 90 days
verificationFactor  0.7 with a verified email, 0.85 with a phone, 1.0 with GitHub or anything above
```

| Giver | Weight |
| --- | --- |
| Bronze, 8 days old, email only | 0.32 |
| Silver, 45 days, phone | 0.74 |
| Gold, 200 days, GitHub | 1.50 |
| Mythic, 400 days, GitHub | 2.25 |

**Who counts.** The trust gate (`src/lib/trust.ts`) decides first: an account under 7 days old, or with an unverified email, gives weight **0**. The Prop is recorded (so the giver sees it went through) but adds nothing to the score and pays the author nothing. A giver with a block with the author cannot see the post at all.

**XP.** `PROPS_RECEIVED` pays the author 2 XP through `grant()`, once per giver and post, at most 20 XP (10 Props) a day, and only when the giver is trusted (`PEER_PAIRS`). Taking Props back lowers the score by the stored weight; XP already paid is not clawed back, and giving again pays nothing new. It feeds the `props_received` metric (achievements *Props 10* and *Props 100*).

**Abuse signals.** Not an automatic penalty, a signal for a person to look at (`IntegritySignal`, at most one per subject per hour):

- `PROP_VELOCITY_GIVER`: one giver gave more than 30 Props in 10 minutes.
- `PROP_VELOCITY_POST`: more than 12 Props from accounts under 30 days old arrived on one post within 10 minutes.

## Comments, follows, watches

- **Comments.** One level: a comment, and replies to it; a reply to a reply is `COMMENT_REPLY_DEPTH`. Up to 2,000 characters. Editable for **15 minutes** (`COMMENT_EDIT_WINDOW_CLOSED` after). Soft delete by the author or an admin; the replies under it stay. Whoever can see the post can comment, unless blocked with the author; a reply to a person who has a block with you is refused.
- **Follow.** User to user. Following shows their `FOLLOWERS` posts and lifts their posts in your feed (below). Not yourself, not with a block (`USER_BLOCKED` when you blocked them, "not found" when they blocked you). A follower the trust gate does not trust does not notify the person.
- **Watch.** User to project. New posts on the project reach the watcher. A private project can only be watched by its members.
- **Notifications** stand for several events (`src/lib/notifications.ts`, `coalesceNotification`): the first event in an hour creates one row; the next ones in the same hour only raise its `count` and rewrite its text ("12 people gave Props to X"), mark it unread and bring it back to the top. The key is `subject + hour`, taken under an advisory lock, so parallel events do not lose counts. Per-type preferences are in `/api/notifications/preferences`: `PROPS`, `COMMENT`, `FOLLOW`, `WATCH` (all on until switched off). A watcher notification is not sent inside the request: the post's route queues the `posts/notify-watchers` job, which reads the watchers 500 at a time, drops the ones who may not see the post, and queues itself for the next 500.

## The feed

`GET /api/feed?tab=for-you|following|city|campus&cursor=&limit=` (limit 1 to 50, default 20).

| Tab | Candidates |
| --- | --- |
| `for-you` | everything the viewer may see, from the last 7 days |
| `following` | posts by people the viewer follows |
| `city` | posts by people in the viewer's city (`Profile.cityKey`); empty until they set one |
| `campus` | the same for `Profile.campusKey` |

Always removed: deleted posts, posts the viewer may not see (visibility), and everything by an author the viewer has a block with, in either direction.

### Ranking v1

```
score = recencyDecay * (1 + ln(1 + propsScore)) * networkBoost * proofBoost

recencyDecay  0.5 ^ (ageHours / 24)             a day-old post is worth half of a fresh one
propsScore    the post's weighted Props          the log keeps a viral post from burying the rest
networkBoost  1 stranger, 1.5 follow, 1.8 crew (shared project or crew), 2.2 match
              the closest tie counts; they do not multiply
proofBoost    1 + 0.05 per tier above Bronze     1.00 to 1.25: proof of work lifts a post a little and never decides
```

**Worked example**, at one instant:

| Post | Age | propsScore | Tie | Author tier | recency | props | network | proof | **score** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 2 h | 0 | stranger | Bronze | 0.944 | 1.000 | 1.0 | 1.00 | **0.944** |
| B | 24 h | 10 | stranger | Bronze | 0.500 | 3.398 | 1.0 | 1.00 | **1.699** |
| C | 30 h | 3 | follow | Gold | 0.420 | 2.386 | 1.5 | 1.10 | **1.655** |
| D | 6 h | 1.5 | match | Silver | 0.841 | 1.916 | 2.2 | 1.05 | **3.722** |

Order: D, B, C, A. A day-old post with ten weighted Props beats a fresh one with none; a followed author's thirty-hour-old post nearly keeps up with it. Ties in score go to the newer post, then to the larger id, so the order never depends on the order the rows came back in.

**Diversity.** A page holds **at most two posts per author**. What the cap held back is not lost: it leads the next page's candidates, and is capped again there.

### How it is built: fan-out on read

Nothing is written when someone posts. A request builds a **candidate window** (the viewer's 300 most recent visible posts for the tab in the last 7 days; `Index: ShipPost(createdAt)` and the author and project indexes), ranks it in memory and cuts a page. The window is **cached per viewer, tab and minute** (`feed:win:{viewer}:{tab}:{minute}`, two minutes' life); an **empty window is not cached**, so someone who has just posted or followed sees it at once. The network ties (matches, crew, follows) are read per request, small and indexed.

**The cursor** is opaque: `{ asOf, page }`, base64url. `asOf` is the instant the first page was ranked at, so every later page ranks the same window the same way and the pages do not repeat or skip a post while someone scrolls (a Prop landing in between can move a post a little). A cursor is good for an hour; a malformed, expired or future one is `400 INVALID_CURSOR` and the client starts again without it.

Timelines (`/api/projects/{id}/timeline`, `/api/users/{id}/posts`) are chronological, newest first, keyset-paged on `(createdAt, id)` with the same visibility and block rules.

### Migration path to fan-out on write

Fan-out on read costs one windowed query per viewer per minute, which is right while the platform is small: no write amplification, no backfill, a block or a delete takes effect on the next read. It stops being right when the window query dominates the database (many viewers per second, or authors with very many followers is not the problem here; the *viewers* are). The path, in order, each step shippable alone:

1. **Raise the cache's reach.** Make the window shared across viewers for the `for-you` and city/campus tabs (key without the viewer, filter the viewer's blocks and visibility after), cutting the queries to one per tab per minute.
2. **Precompute hot lists.** A job writes the top N public posts per city, campus and global every minute into the cache; `for-you` merges that list with the viewer's own `following` window.
3. **Fan-out on write for the `following` tab only.** On a post, a job (`posts/fan-out`, batched like `posts/notify-watchers`, 500 followers per job) pushes the post id onto each follower's capped list (Redis sorted set, 500 entries, score = createdAt). The tab then reads the list and hydrates by id. Authors with more than ~10,000 followers are *not* fanned out; their posts are merged in on read (the usual hybrid). Deletes and blocks are filtered at read time, so they never need to be fanned out.
4. **Keep the ranker.** `ranking.ts` is pure and takes a list of candidates, so none of the above changes how a post is scored; only where the candidates come from.

## Ship Day

Friday, **in each person's own time zone** (`src/lib/ship-day.ts`). A post made during the author's local Friday carries `shipDayKey` (that date) and the `ship-day` stack tag. A Ship Day post counts once per Ship Day for the `ship_day_posts` metric however many are made (achievements *Friday Shipper* at 1 and *Ship Day Regular* at 10), so it cannot be farmed. It pays no XP of its own.

`GET /api/ship-day` answers for the caller's own Friday of this week:

```
{ isShipDay, startsAt, endsAt, dateKey, weekKey, todayCount, yourShips[], topPosts[], lastRecap }
```

- `isShipDay`: whether the caller's Friday is today. On a Saturday or Sunday the Friday is behind them: `false`, and `endsAt` is in the past. (The API does not skip ahead to next week.)
- `todayCount`: Ship Day posts platform-wide on that date key so far. A cache counter (`shipday:count:{date}`, 3 days) bumped when a post is created; if the cache has lost it, it is rebuilt from the table. Before the day starts it is 0.
- `yourShips`: the caller's own (or co-authored) posts of that day. `topPosts`: the day's best visible posts by `propsScore` (10).
- `lastRecap`: the latest finished week's recap, or `null`.

**The Saturday recap.** The job `posts/ship-day-recap` runs **Saturday 12:30 UTC**, when UTC-12, the last zone to leave Friday, is already into Saturday. It writes one `ShipDayRecap` per ISO week (`weekKey` is unique, so running it twice, or concurrently, writes once): the week's Friday date, the total number of posts, the ten best public posts, and the counts per country, city and campus (the top 50 of each). The week key is the ISO week of the Friday, so it is the same whatever zone the author is in.

## Indexes

| Path | Index |
| --- | --- |
| a person's posts | `ShipPost(authorId, createdAt)` |
| a project's or crew's timeline | `ShipPost(projectId, createdAt)`, `ShipPost(teamId, createdAt)` |
| the feed window, the recap | `ShipPost(createdAt)`, `ShipPost(shipDayKey)` |
| co-authored posts | GIN on `coAuthorIds` |
| Props, one per pair | unique `Prop(userId, postId)` |
| followers, followees | unique `Follow(followerId, followeeId)`, `Follow(followeeId, createdAt)` |
| watchers of a project | `Watch(projectId)`, unique `Watch(userId, projectId)` |
| notifications that coalesce | unique `Notification(userId, coalesceKey)` |
