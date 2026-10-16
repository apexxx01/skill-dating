-- AlterTable
ALTER TABLE "Achievement" ADD COLUMN     "rarity" DOUBLE PRECISION,
ADD COLUMN     "rarityUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressTick" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgressTick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserCounter_userId_key_key" ON "UserCounter"("userId", "key");

-- CreateIndex
CREATE INDEX "ProgressTick_userId_metric_createdAt_idx" ON "ProgressTick"("userId", "metric", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProgressTick_userId_metric_dedupeKey_key" ON "ProgressTick"("userId", "metric", "dedupeKey");

-- CreateIndex
CREATE INDEX "User_lastActiveAt_idx" ON "User"("lastActiveAt");

-- AddForeignKey
ALTER TABLE "UserCounter" ADD CONSTRAINT "UserCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressTick" ADD CONSTRAINT "ProgressTick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Counters start from what the XP log already says each user has done, so nobody begins at zero.
-- Every kind of thing counted here is counted only when it paid XP, and the XP log holds exactly
-- those awards, so this is the same number the engine would have reached. Nothing is unlocked by
-- this: an achievement whose target a counter already meets unlocks on the user's next action of
-- that kind. "Endorsements given" is read from the endorser encoded in the award's source
-- ("<evidenceId>:<endorserId>").
INSERT INTO "UserCounter" ("id", "userId", "key", "value", "updatedAt")
SELECT gen_random_uuid()::text, counted."userId", counted."key", counted."value", CURRENT_TIMESTAMP
FROM (
  SELECT x."userId", m."key", COUNT(*)::int AS "value"
  FROM "XPEvent" x
  JOIN (VALUES
    ('PROJECT_CREATED', 'projects_created'),
    ('PROJECT_SHIP', 'ships'),
    ('MILESTONE_COMPLETED', 'milestones'),
    ('PROJECT_UPDATE_POSTED', 'updates'),
    ('EVIDENCE_ADDED', 'evidence_added'),
    ('EVIDENCE_ENDORSED', 'endorsements_received'),
    ('HACKATHON_JOIN', 'hackathons_joined'),
    ('HACKATHON_WIN', 'hackathon_wins'),
    ('TEAM_FORMED', 'crews_formed'),
    ('TEAM_APPLICATION_ACCEPTED', 'teams_joined'),
    ('CONNECTION_ACCEPTED', 'connections'),
    ('MESSAGE_SENT_FIRST_IN_CONNECTION', 'first_messages')
  ) AS m("type", "key") ON m."type" = x."type"
  GROUP BY x."userId", m."key"
  UNION ALL
  SELECT endorser."userId", 'endorsements_given', COUNT(*)::int
  FROM (
    SELECT split_part(x."sourceId", ':', 2) AS "userId"
    FROM "XPEvent" x
    WHERE x."type" = 'EVIDENCE_ENDORSED' AND x."sourceId" LIKE '%:%'
  ) endorser
  JOIN "User" u ON u."id" = endorser."userId"
  GROUP BY endorser."userId"
) counted;
