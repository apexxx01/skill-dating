-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonStanding" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonStanding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Season_number_key" ON "Season"("number");

-- CreateIndex
CREATE INDEX "Season_active_idx" ON "Season"("active");

-- CreateIndex
CREATE INDEX "SeasonStanding_seasonId_rank_idx" ON "SeasonStanding"("seasonId", "rank");

-- CreateIndex
CREATE INDEX "SeasonStanding_userId_idx" ON "SeasonStanding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonStanding_seasonId_userId_key" ON "SeasonStanding"("seasonId", "userId");

-- CreateIndex
CREATE INDEX "XPEvent_createdAt_idx" ON "XPEvent"("createdAt");

-- CreateIndex
CREATE INDEX "XPEvent_seasonId_userId_idx" ON "XPEvent"("seasonId", "userId");

-- AddForeignKey
ALTER TABLE "XPEvent" ADD CONSTRAINT "XPEvent_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonStanding" ADD CONSTRAINT "SeasonStanding_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonStanding" ADD CONSTRAINT "SeasonStanding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Season 1 starts when this migration is deployed and runs for eight weeks. CURRENT_TIMESTAMP is
-- the same instant throughout one migration, so the length is exact. XP earned before this point
-- keeps a null seasonId.
INSERT INTO "Season" ("id", "number", "name", "startsAt", "endsAt", "active", "createdAt")
VALUES ('season-1', 1, 'Season 1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '8 weeks', true, CURRENT_TIMESTAMP);
