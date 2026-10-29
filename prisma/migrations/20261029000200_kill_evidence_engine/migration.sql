-- Two more kill switches (src/lib/ops/kill-switches.ts), created OFF: the evidence engine (no GitHub syncs or rechecks; its write routes answer 503
-- EVIDENCE_ENGINE_PAUSED) and the public receipt pages (GET /api/receipts/{id} answers 503 RECEIPTS_PAUSED; the key set stays up so receipts already
-- copied elsewhere can still be verified).
INSERT INTO "FeatureFlag" ("id", "key", "description", "enabled", "rolloutPercent", "allowUserIds", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'kill.evidence-engine', 'Kill switch: no GitHub syncs or receipt rechecks (503 EVIDENCE_ENGINE_PAUSED; the jobs skip). Owner: Trust & Safety lead.', false, 100, '{}', now(), now()),
  (gen_random_uuid()::text, 'kill.receipts-public', 'Kill switch: public receipt pages answer 503 RECEIPTS_PAUSED (the key set stays up). Owner: Trust & Safety lead.', false, 100, '{}', now(), now())
ON CONFLICT ("key") DO NOTHING;
