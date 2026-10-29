# Backlog

What is planned after Stage 1I (the evidence engine, [PROOF.md](PROOF.md)), by the stage it is planned for. One line each; each item gets its own design
when its stage starts.

## 1J: proof of control, in person

- **Proof-of-control providers**: more receipt sources beyond GitHub (domains, package registries, app stores), each proving the person controls the account.
- **Rotating-QR IRL check-ins**: a short-lived, rotating QR code at an event, scanned to prove two people met in person.

## 1K: GitHub, deeper

- **GitHub App**: an installation token as the first auth source of the engine (higher limits, private repositories with consent); no caller changes.
- **Deploy webhooks**: a deploy of a claimed project becomes evidence, from the provider's signed webhook.
- **Changelogs and RSS**: a project's changelog or feed read into its timeline.
- **README badge**: an image link a repository can show, pointing at the owner's receipt.
- **passport.json and a CV**: the passport as a signed, machine-readable file, and a printable CV made from it.

## 1L: matching that learns

- **Builder DNA**: a profile of how someone builds, from their evidence (languages, cadence, collaboration).
- **Behaviour calibration**: what people say about themselves corrected by what they do.
- **Complementarity**: matching on what a pair is missing, not only on what they share.
- **Moment-triggered Drops**: a drop sent when something happens (a ship, a hackathon) rather than at a fixed time.
- **Serendipity slot**: one deliberately unexpected candidate in a day's drops.
- **Steerable Drops bandit**: drops that learn from what a person answers, within limits they can steer.
- **Trial Sprint**: a short, scoped first project two matched people try before committing.
- **Alignment Cards**: a few questions both answer before teaming up, to surface mismatches early.
- **Outcome tracking**: whether a match led to a team, a ship, a lasting collaboration.
- **Fairness audit**: regular checks that matching does not disadvantage groups of people.

## 1M: squads that last

- **Squad Charter**: what a squad agrees on at the start (roles, hours, decisions).
- **Heartbeat**: a light, regular check that a squad is still moving.
- **Backfill**: finding someone to take an empty seat mid-project.
- **Graceful Exit**: leaving a squad without burning it: handover and credit kept.
- **Apprentice slot**: a seat for a beginner to learn on a real project.
- **Deadline autopilot**: reminders and re-planning as a hackathon deadline nears.
- **Project Adoption**: an abandoned project handed on to new owners.
- **Contribution Ledger**: who did what in a squad, from evidence and receipts.
- **Async standups**: short written check-ins instead of meetings.

## 1N: trust between people

- **Trust Paths and warm intros**: how two people are connected through people both trust, and an introduction along that path (reads VerifiedCollaboration).
- **Double-blind references**: references collected so neither side sees the other's answer until both have given one.
- **Mentor lineage**: who mentored whom, shown as a line through the passport.
- **Inbound controls**: who may reach a person, by trust, not only by connection.

## 1O: platform

- **Delta endpoint**: what changed since a cursor, for clients that keep a local copy.
- **30-second undo**: a short window to take back a destructive action.
- **ICS feed**: hackathons and squad deadlines as a calendar feed.
- **API tokens and webhooks**: personal access tokens and outgoing webhooks for builders' own tools.
- **Saved searches with alerts**: a search kept and run again, with a notification when something new matches.
- **Sparse fieldsets**: asking for only the fields a screen needs.
- **Image variants**: sized and formatted copies of uploads.
- **Notification send-time and a daily budget**: learning when a person reads, and capping how much reaches them a day.
- **Vanity handles**: a chosen short handle in addition to the username.
- **Adapter fault injection**: making each infrastructure adapter fail on purpose in tests and staging.
- **Semantic search and a skill ontology**: search by meaning, and skills related to each other (a parent, a near neighbour).

## Later

- **Organizer Kit**: tools for people who run hackathons and meetups.
- **Builder Wrapped**: a person's year in review.
- **Campus Cup**: a competition between campus chapters.
- **Co-op quests**: quests a group completes together.
- **Scouts**: people who find and vouch for promising newcomers.
- **Asks**: a lightweight way to ask the community for help.
- **Demo Day Live**: live demos with an audience.
- **Weekly Pods**: small standing groups that meet every week.
- **AI layer**: Ask the Passport, a submission packager, grounded openers, ship drafts.
- **Bounties**: paid tasks on projects.
- **Hire-a-Crew**: hiring a whole squad for a piece of work.
