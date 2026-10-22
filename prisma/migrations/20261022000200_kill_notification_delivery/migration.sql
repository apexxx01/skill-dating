-- A kill switch for the delivery pipeline (src/lib/notify): ON stops every email and push at once (in-app notifications are unaffected), until it is turned off.
-- Held deliveries wait; the ones too old by then are dropped. Created OFF; changed with PATCH /api/admin/flags/{key}.
INSERT INTO "FeatureFlag" ("id", "key", "description", "enabled", "rolloutPercent", "allowUserIds", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'kill.notification-delivery', 'Kill switch: no email and no push leave the platform (the delivery job skips). Owner: engineering on-call.', false, 100, '{}', now(), now())
ON CONFLICT ("key") DO NOTHING;
