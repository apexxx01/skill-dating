-- The kill switches (src/lib/ops/kill-switches.ts): one feature flag each, created OFF. Turning a flag ON stops that feature for everyone at once,
-- with a clear error code, until it is turned off again (PATCH /api/admin/flags/{key}). The owner of each is in the description and in docs/DEPLOY.md.
INSERT INTO "FeatureFlag" ("id", "key", "description", "enabled", "rolloutPercent", "allowUserIds", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'kill.signups', 'Kill switch: no new accounts (503 SIGNUPS_PAUSED). Owner: engineering on-call.', false, 100, '{}', now(), now()),
  (gen_random_uuid()::text, 'kill.romance', 'Kill switch: the romance mode is closed (503 ROMANCE_PAUSED). Owner: Trust & Safety lead.', false, 100, '{}', now(), now()),
  (gen_random_uuid()::text, 'kill.messaging', 'Kill switch: nobody can send messages (503 MESSAGING_PAUSED). Owner: Trust & Safety lead.', false, 100, '{}', now(), now()),
  (gen_random_uuid()::text, 'kill.posting', 'Kill switch: no posts, comments, LFG posts or ideas (503 POSTING_PAUSED). Owner: Trust & Safety lead.', false, 100, '{}', now(), now()),
  (gen_random_uuid()::text, 'kill.external-hackathons', 'Kill switch: no external hackathon submissions (503 EXTERNAL_HACKATHONS_PAUSED). Owner: Squads product owner.', false, 100, '{}', now(), now()),
  (gen_random_uuid()::text, 'kill.squad-autoform', 'Kill switch: the solo pool forms no automatic squads (the job skips). Owner: Squads product owner.', false, 100, '{}', now(), now())
ON CONFLICT ("key") DO NOTHING;
