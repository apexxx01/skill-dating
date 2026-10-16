-- DropIndex
DROP INDEX "UserQuest_userId_questId_key";

-- AlterTable
ALTER TABLE "Quest" ALTER COLUMN "startsAt" DROP NOT NULL,
ALTER COLUMN "endsAt" DROP NOT NULL;

-- AlterTable: the period columns arrive nullable, existing rows (hand-made quests from before periods)
-- are given a period of their own, and only then do the columns become required.
ALTER TABLE "UserQuest" ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodKey" TEXT,
ADD COLUMN     "periodStart" TIMESTAMP(3);

UPDATE "UserQuest" SET "periodKey" = 'legacy', "periodStart" = "createdAt", "periodEnd" = "createdAt";

ALTER TABLE "UserQuest" ALTER COLUMN "periodEnd" SET NOT NULL,
ALTER COLUMN "periodKey" SET NOT NULL,
ALTER COLUMN "periodStart" SET NOT NULL;

-- CreateIndex
CREATE INDEX "UserQuest_userId_periodEnd_idx" ON "UserQuest"("userId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "UserQuest_userId_questId_periodKey_key" ON "UserQuest"("userId", "questId", "periodKey");

-- Quests can be paused everywhere, or rolled out gradually, with the "quests" feature flag
-- (docs/GAMIFICATION.md). It starts switched on for everybody; a flag that does not exist is off.
INSERT INTO "FeatureFlag" ("id", "key", "description", "enabled", "rolloutPercent", "allowUserIds", "updatedAt")
VALUES ('flag-quests', 'quests', 'Daily and weekly quests: their progress and the XP they pay. Switch off to pause them for everybody.', true, 100, ARRAY[]::TEXT[], CURRENT_TIMESTAMP);
