-- The rewards engine records what each XP award was for and a key that identifies
-- "the same award", so a retry or a race cannot pay twice (src/lib/rewards.ts).

-- AlterTable
ALTER TABLE "XPEvent" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "seasonId" TEXT,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- Existing rows. Achievement awards can be tied back to their achievement through
-- the description they were written with, so they get the same key the engine uses
-- now ("achievement:<slug>"). If a user somehow holds two rows for one achievement,
-- only the earliest is keyed, so the unique index below cannot fail. Every other
-- type has no recoverable source and keeps a null key, which the index treats as
-- distinct: those rows are left exactly as they were.
UPDATE "XPEvent" AS x
SET "sourceType" = 'ACHIEVEMENT',
    "sourceId"   = ranked."slug",
    "dedupeKey"  = 'achievement:' || ranked."slug"
FROM (
  SELECT e."id",
         a."slug",
         row_number() OVER (PARTITION BY e."userId", a."slug" ORDER BY e."createdAt", e."id") AS rn
  FROM "XPEvent" e
  JOIN "Achievement" a ON e."description" = 'Earned achievement "' || a."name" || '"'
  WHERE e."type" = 'ACHIEVEMENT_EARNED'
) AS ranked
WHERE x."id" = ranked."id" AND ranked.rn = 1;

-- CreateIndex
CREATE INDEX "XPEvent_userId_createdAt_idx" ON "XPEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "XPEvent_userId_type_createdAt_idx" ON "XPEvent"("userId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "XPEvent_userId_type_dedupeKey_key" ON "XPEvent"("userId", "type", "dedupeKey");
